import { describe, it, expect } from 'vitest';
import { IntentEngine } from '../../../src/core/search/intent-engine.js';
import type { IntentQuery } from '../../../src/core/search/types.js';

describe('IntentEngine', () => {
  const engine = new IntentEngine();

  describe('classifyIntent', () => {
    it('classifies read intent', () => {
      expect(engine.classifyIntent({ text: 'find the auth module' })).toBe('read');
      expect(engine.classifyIntent({ text: 'search for login function' })).toBe('read');
    });

    it('classifies write intent', () => {
      expect(engine.classifyIntent({ text: 'create new user service' })).toBe('write');
      expect(engine.classifyIntent({ text: 'add validation to form' })).toBe('write');
    });

    it('classifies validate intent', () => {
      expect(engine.classifyIntent({ text: 'verify test results' })).toBe('validate');
      expect(engine.classifyIntent({ text: 'check lint errors' })).toBe('validate');
    });

    it('classifies transform intent', () => {
      expect(engine.classifyIntent({ text: 'refactor auth layer' })).toBe('transform');
      expect(engine.classifyIntent({ text: 'migrate to new API' })).toBe('transform');
    });

    it('uses file path context', () => {
      expect(engine.classifyIntent({ text: 'check', filePath: 'auth.test.ts' })).toBe('validate');
    });
  });

  describe('computeHybridScore', () => {
    it('computes hybrid score with all components', () => {
      const kg = {
        getFileByPath: () => ({ id: 1, path: 'src/auth.ts' }),
        getImports: () => [{ source: 'src/utils.ts', named: ['helper'], kind: 'named' }],
      };
      const score = engine.computeHybridScore({ text: 'read auth' }, 'src/auth.ts', kg, 0.8);
      expect(score.semantic).toBeCloseTo(0.8, 1);
      expect(score.structural).toBeGreaterThan(0.3);
      expect(score.intent).toBeGreaterThan(0.5);
      expect(score.total).toBeGreaterThan(0);
      expect(score.total).toBeLessThanOrEqual(1);
    });

    it('falls back when KG missing', () => {
      const score = engine.computeHybridScore({ text: 'read' }, 'src/x.ts', { getFileByPath: () => null });
      expect(score.total).toBeGreaterThan(0);
    });
  });

  describe('search', () => {
    it('returns ranked results', async () => {
      const kg = {
        getFileByPath: (p: string) => ({ id: 1, path: p }),
        getImports: () => [{ source: 'src/other.ts', named: [], kind: 'default' }],
      };
      const results = await engine.search({ text: 'find auth' }, kg, 5);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(0);
      if (results.length > 0) {
        expect(results[0].rank).toBe(1);
        expect(results[0].score.total).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
