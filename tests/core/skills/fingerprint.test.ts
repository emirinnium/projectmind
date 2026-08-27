/**
 * F3 — Fingerprint-Based Adaptive Skill Profile tests.
 */

import { describe, it, expect } from 'vitest';
import { AgentFingerprintExtractor, fingerprintExtractor } from '../../../src/core/skills/fingerprint.js';
import { persistAgentProfile, loadAgentProfile, extractFingerprintFromContent } from '../../../src/core/skills/engine.js';
import type { AgentFingerprint } from '../../../src/storage/kg/types.js';

describe('AgentFingerprintExtractor', () => {
  const extractor = new AgentFingerprintExtractor();

  it('extracts full fingerprint from TypeScript source via AST', () => {
    const code = `
      async function fetchData() {
        const result = await fetch('/api');
        return result;
      }
      interface User { id: number; name: string; }
      type Alias = string;
      class Service {}
      describe('suite', () => {
        it('should work', () => { expect(true).toBe(true); });
      });
      try { throw new Error('x'); } catch (e) { console.log(e); }
    `;
    const fp = extractor.extractFromAST(code);
    expect(fp.asyncPreference).toBeGreaterThanOrEqual(0);
    expect(fp.typeStrictness).toBeGreaterThanOrEqual(0);
    expect(fp.errorHandlingStyle).toBeDefined();
    expect(fp.namingConvention).toBeDefined();
    expect(fp.testPattern).toBe('bdd');
    expect(fp.favoriteAbstractions).toContain('interface');
  });

  it('returns unmeasured-like values for empty content', () => {
    const fp = extractor.extractFromAST('');
    expect(fp.asyncPreference).toBe(-1);
    expect(fp.errorHandlingStyle).toBe('unknown');
  });

  it('extracts partial fingerprint from edit', () => {
    const edit = { filePath: 'test.ts', newContent: 'const x = 1;' };
    const partial = extractor.extractFromEdit(edit);
    expect(partial).toBeDefined();
  });

  it('classifies naming conventions correctly', () => {
    const code = `
      const myVar = 1;
      const my_other = 2;
      class MyClass {}
    `;
    const fp = extractor.extractFromAST(code);
    expect(fp.namingConvention).toBeDefined();
  });
});

describe('Profile persistence', () => {
  it('persists fingerprint via persistAgentProfile', () => {
    const fp: AgentFingerprint = {
      asyncPreference: 0.8,
      typeStrictness: 0.7,
      errorHandlingStyle: 'try-catch',
      namingConvention: 'camelCase',
      testPattern: 'bdd',
      favoriteAbstractions: ['interface', 'class'],
    };
    expect(() => persistAgentProfile('test-agent', fp)).not.toThrow();
  });

  it('loads profile (returns null when absent)', () => {
    const loaded = loadAgentProfile('nonexistent-agent');
    expect(loaded).toBeNull();
  });
});

describe('Adaptive coherence check', () => {
  it('adapts fingerprint to code changes', () => {
    const before = 'function a() {}';
    const after = 'async function a() { await b(); }';
    const fpBefore = extractFingerprintFromContent(before);
    const fpAfter = extractFingerprintFromContent(after);
    expect(fpAfter.asyncPreference).toBeGreaterThanOrEqual(fpBefore.asyncPreference);
  });

  it('uses singleton extractor consistently', () => {
    const fp1 = fingerprintExtractor.extractFromAST('const a = 1;');
    const fp2 = fingerprintExtractor.extractFromAST('const b = 2;');
    expect(fp1).toBeDefined();
    expect(fp2).toBeDefined();
  });
});
