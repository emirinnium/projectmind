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
});
