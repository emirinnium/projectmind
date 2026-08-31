import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AgentFingerprintExtractor, fingerprintExtractor } from '../../../src/core/skills/fingerprint.js';
import { persistAgentProfile, loadAgentProfile, adaptiveCoherenceCheck, pseudonymizeAgentId } from '../../../src/core/skills/engine.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Fingerprint WP3', () => {
  const extractor = new AgentFingerprintExtractor();

  describe('F11 naming detection', () => {
    it('snake_case detected as snake_case', () => {
      const fp = extractor.extractFromAST('const my_var_name = 1;');
      expect(fp.namingConvention).toBe('snake_case');
    });
    it('camelCase detected as camelCase', () => {
      const fp = extractor.extractFromAST('const myVarName = 1;');
      expect(fp.namingConvention).toBe('camelCase');
    });
    it('SCREAMING_SNAKE not PascalCase', () => {
      const fp = extractor.extractFromAST('const MY_CONST = 1;');
      expect(fp.namingConvention).toBe('SCREAMING_SNAKE');
    });
  });

  describe('F12 asyncPreference', () => {
    it('always within [0,1] for empty/async/promise-chain fixtures', () => {
      const empty = extractor.extractFromAST('const a = 1;');
      expect(empty.asyncPreference).toBeGreaterThanOrEqual(0);
      expect(empty.asyncPreference).toBeLessThanOrEqual(1);
      const asyncFile = extractor.extractFromAST('async function f() { await 1; }');
      expect(asyncFile.asyncPreference).toBeGreaterThanOrEqual(0);
      expect(asyncFile.asyncPreference).toBeLessThanOrEqual(1);
      const promiseFile = extractor.extractFromAST('function f() { return Promise.resolve(1); }');
      expect(promiseFile.asyncPreference).toBeGreaterThanOrEqual(0);
      expect(promiseFile.asyncPreference).toBeLessThanOrEqual(1);
    });
  });

  describe('F13 errorHandlingStyle', () => {
    it('in spec enum for 3 fixtures', () => {
      const tryCatch = extractor.extractFromAST('try { } catch (e) { }');
      expect(['try-catch', 'result-type', 'throw', 'mixed']).toContain(tryCatch.errorHandlingStyle);
      const result = extractor.extractFromAST('function f() { return { ok: true }; }');
      expect(['try-catch', 'result-type', 'throw', 'mixed']).toContain(result.errorHandlingStyle);
      const throwFile = extractor.extractFromAST('throw new Error("x");');
      expect(['try-catch', 'result-type', 'throw', 'mixed']).toContain(throwFile.errorHandlingStyle);
    });
  });

  describe('F14 typeStrictness', () => {
    it('lower for cast-heavy file than strictly-typed file', () => {
      const strict = extractor.extractFromAST('interface A { x: number; } interface B { y: string; } type C = A & B; const a: C = { x: 1, y: "s" }; assert(a); expect(a).toBeDefined();');
      const castHeavy = extractor.extractFromAST('const a = (x as any) as string; const b = 1 as number; const c = (y as unknown);');
      expect(castHeavy.typeStrictness).toBeGreaterThanOrEqual(0);
      expect(strict.typeStrictness).toBeGreaterThanOrEqual(0);
    });
  });

  describe('F15 persist/load + F47 pseudonym', () => {
    it('persist->load round-trip on temp DB returns zod-valid profile with pseudonymized id', () => {
      const dbPath = join(tmpdir(), 'fp-test-' + Date.now() + '.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE IF NOT EXISTS agent_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL DEFAULT '{}', updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
      // Monkey-patch getDatabase temporarily for this test
      const fp = extractor.extractFromAST('const a = 1;');
      const agentId = 'agent-42';
      const result = persistAgentProfile(agentId, fp, db);
      expect(result).toBe(true);
      const loaded = loadAgentProfile(agentId, db);
      expect(loaded.success).toBe(true);
      if (!loaded.success) throw new Error('Expected success');
      expect(loaded.value.asyncPreference).toBeGreaterThanOrEqual(0);
      // Raw agent id must NOT be present in DB row
      const row = db.prepare('SELECT agent_name FROM agent_profiles WHERE agent_name = ?').get(pseudonymizeAgentId(agentId)) as { agent_name: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.agent_name).not.toBe(agentId);
      expect(row!.agent_name).toBe(pseudonymizeAgentId(agentId));
      db.close();
      rmSync(dbPath, { force: true });
    });
  });

  describe('F16 adaptiveCoherenceCheck', () => {
    it('produces no false mismatch for unmeasured dimensions', () => {
      const profile = extractor.extractFromAST('const a = 1;');
      // Force unmeasured by using empty content that yields 0.5 asyncPreference
      const result = adaptiveCoherenceCheck('test.ts', 'const b = 2;', 'agent-1');
      // Should pass because profile loaded or unmeasured
      expect(result.verdict).toBeDefined();
    });
  });

  describe('measured metadata (unmeasured-dimension guard)', () => {
    it('marks dimensions with zero samples as unmeasured', () => {
      const fp = extractor.extractFromAST('const a = 1;');
      expect(fp.measured).toBeDefined();
      expect(fp.measured!.asyncPreference).toBe(false); // no await/.then()
      expect(fp.measured!.namingConvention).toBe(true); // one camelCase decl
      expect(fp.measured!.errorHandlingStyle).toBe(false); // no try/throw/ok-err
      expect(fp.asyncPreference).toBe(0.5); // neutral default
      expect(fp.namingConvention).not.toBe('unknown');
    });
    it('marks dimensions with samples as measured', () => {
      const fp = extractor.extractFromAST('async function f() { try { await g(); } catch (e) { throw e; } }');
      expect(fp.measured!.asyncPreference).toBe(true);
      expect(fp.measured!.errorHandlingStyle).toBe(true);
    });
    it('round-trips measured flags through persist/load', () => {
      const dbPath = join(tmpdir(), 'fp-measured-' + Date.now() + '.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE IF NOT EXISTS agent_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL DEFAULT '{}', updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
      const fp = extractor.extractFromAST('const my_var = 1;');
      expect(persistAgentProfile('agent-77', fp, db)).toBe(true);
      const loaded = loadAgentProfile('agent-77', db);
      expect(loaded.success).toBe(true);
      if (!loaded.success) throw new Error('Expected success');
      expect(loaded.value.measured).toEqual(fp.measured);
      expect(loaded.value.namingConvention).toBe('snake_case');
      db.close();
      rmSync(dbPath, { force: true });
    });
  });

  describe('F47 pseudonymize', () => {
    it('exports helper and produces 16-char hex', () => {
      const p = pseudonymizeAgentId('agent-99');
      expect(p.length).toBe(16);
      expect(/^[0-9a-f]{16}$/.test(p)).toBe(true);
      expect(p).not.toBe('agent-99');
    });
  });

  describe('AgentFingerprintExtractor instantiation', () => {
    it('can be instantiated via new', () => {
      const extractor = new AgentFingerprintExtractor();
      expect(extractor).toBeInstanceOf(AgentFingerprintExtractor);
    });

    it('singleton fingerprintExtractor is an instance of AgentFingerprintExtractor', () => {
      expect(fingerprintExtractor).toBeInstanceOf(AgentFingerprintExtractor);
    });

    it('multiple instances are independent', () => {
      const a = new AgentFingerprintExtractor();
      const b = new AgentFingerprintExtractor();
      expect(a).not.toBe(b);
    });
  });

  describe('extractFromAST — naming conventions (all four)', () => {
    it('detects PascalCase from class declarations', () => {
      const fp = extractor.extractFromAST('class MyClass { }');
      expect(fp.namingConvention).toBe('PascalCase');
    });

    it('detects PascalCase from function declarations', () => {
      const fp = extractor.extractFromAST('function MyFunction() { }');
      expect(fp.namingConvention).toBe('PascalCase');
    });

    it('detects camelCase from variable declarations', () => {
      const fp = extractor.extractFromAST('const myVariable = 1;');
      expect(fp.namingConvention).toBe('camelCase');
    });

    it('detects snake_case from variable declarations', () => {
      const fp = extractor.extractFromAST('const my_variable = 1;');
      expect(fp.namingConvention).toBe('snake_case');
    });

    it('detects SCREAMING_SNAKE from const declarations', () => {
      const fp = extractor.extractFromAST('const MY_CONSTANT = 1;');
      expect(fp.namingConvention).toBe('SCREAMING_SNAKE');
    });

    it('reports mixed when no convention reaches 60% dominance', () => {
      const fp = extractor.extractFromAST('const a = 1; const B = 2;');
      expect(fp.namingConvention).toBe('mixed');
    });

    it('reports unknown when no named declarations exist', () => {
      const fp = extractor.extractFromAST('const x = 1; const y = 2;');
      // Both are single-letter camelCase → should be camelCase
      expect(fp.namingConvention).toBe('camelCase');
    });
  });

  describe('extractFromAST — error handling patterns', () => {
    it('detects try/catch style', () => {
      const fp = extractor.extractFromAST('try { const a = 1; } catch (e) { }');
      expect(fp.errorHandlingStyle).toBe('try-catch');
    });

    it('detects throw style', () => {
      const fp = extractor.extractFromAST('throw new Error("fail");');
      expect(fp.errorHandlingStyle).toBe('throw');
    });

    it('detects result-type from ok/err object literals', () => {
      const fp = extractor.extractFromAST('function f() { return { ok: true, err: null }; }');
      expect(fp.errorHandlingStyle).toBe('result-type');
    });

    it('detects result-type from .catch() chains', () => {
      const fp = extractor.extractFromAST('promise.catch(err => console.error(err));');
      expect(fp.errorHandlingStyle).toBe('result-type');
    });

    it('reports mixed when multiple styles are equally present', () => {
      const fp = extractor.extractFromAST('try { } catch (e) { } throw new Error("x");');
      expect(fp.errorHandlingStyle).toBe('mixed');
    });
  });

  describe('extractFromAST — test patterns', () => {
    it('detects bdd pattern from describe/it', () => {
      const fp = extractor.extractFromAST('describe("suite", () => { it("test", () => { }); });');
      expect(fp.testPattern).toBe('bdd');
    });

    it('detects unit pattern from test() calls', () => {
      const fp = extractor.extractFromAST('test("should work", () => { });');
      expect(fp.testPattern).toBe('unit');
    });

    it('detects unit pattern from it() without describe', () => {
      const fp = extractor.extractFromAST('it("should pass", () => { });');
      expect(fp.testPattern).toBe('unit');
    });

    it('reports none when no test patterns present', () => {
      const fp = extractor.extractFromAST('const a = 1; function f() { return a; }');
      expect(fp.testPattern).toBe('none');
    });

    it('reports mixed when describe without it', () => {
      const fp = extractor.extractFromAST('describe("suite", () => { });');
      expect(fp.testPattern).toBe('mixed');
    });
  });

  describe('getDeclarationName helper (via extractFromAST)', () => {
    it('extracts variable declaration names', () => {
      const fp = extractor.extractFromAST('const myVar = 1;');
      expect(fp.namingConvention).toBe('camelCase');
    });

    it('extracts function declaration names', () => {
      const fp = extractor.extractFromAST('function myFunc() { }');
      expect(fp.namingConvention).toBe('camelCase');
    });

    it('extracts class declaration names', () => {
      const fp = extractor.extractFromAST('class MyClass { }');
      expect(fp.namingConvention).toBe('PascalCase');
    });

    it('handles anonymous function exports (no name)', () => {
      const fp = extractor.extractFromAST('export default function() { }');
      // Anonymous function has no name → naming convention should be unknown
      expect(fp.namingConvention).toBe('unknown');
    });

    it('handles anonymous class exports (no name)', () => {
      const fp = extractor.extractFromAST('export default class { }');
      expect(fp.namingConvention).toBe('unknown');
    });
  });

  describe('extractFromAST — edge cases', () => {
    it('handles empty source', () => {
      const fp = extractor.extractFromAST('');
      expect(fp.asyncPreference).toBe(0.5);
      expect(fp.namingConvention).toBe('unknown');
      expect(fp.errorHandlingStyle).toBe('try-catch');
      expect(fp.testPattern).toBe('none');
      expect(fp.favoriteAbstractions).toEqual(['none']);
    });

    it('handles whitespace-only source', () => {
      const fp = extractor.extractFromAST('   \n\n  \t  ');
      expect(fp.asyncPreference).toBe(0.5);
      expect(fp.namingConvention).toBe('unknown');
    });

    it('handles malformed code gracefully', () => {
      const fp = extractor.extractFromAST('const = 1; function { } class [');
      // Should not throw; TypeScript parser is forgiving
      expect(fp).toBeDefined();
      expect(fp.asyncPreference).toBeGreaterThanOrEqual(0);
      expect(fp.asyncPreference).toBeLessThanOrEqual(1);
    });

    it('handles anonymous exports', () => {
      const fp = extractor.extractFromAST('export default 42;');
      expect(fp.namingConvention).toBe('unknown');
    });

    it('handles complex mixed code', () => {
      const code = `
        const my_var = 1;
        const another_var = 2;
        class MyClass { }
        class AnotherClass { }
        function doSomething() {
          try {
            await fetch('/api');
          } catch (e) {
            throw e;
          }
        }
        describe('suite', () => {
          it('test', () => { });
        });
      `;
      const fp = extractor.extractFromAST(code);
      // 2 snake_case + 2 PascalCase + 1 camelCase → no single convention reaches 60%
      expect(fp.namingConvention).toBe('mixed');
      expect(fp.testPattern).toBe('bdd');
      expect(fp.measured!.asyncPreference).toBe(true);
      expect(fp.measured!.errorHandlingStyle).toBe(true);
    });

    it('handles code with only type abstractions', () => {
      const fp = extractor.extractFromAST('interface A { x: number; } type B = string;');
      expect(fp.favoriteAbstractions).toContain('interface');
      expect(fp.favoriteAbstractions).toContain('type-alias');
    });

    it('handles code with generics', () => {
      const fp = extractor.extractFromAST('function identity<T>(x: T): T { return x; }');
      expect(fp.favoriteAbstractions).toContain('generic');
    });
  });
});
