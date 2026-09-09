import { describe, expect, it } from 'vitest';
import {
  aggregateRankingScores,
  scoreRankingObservation,
} from '../../src/core/benchmark/scoring.js';
import { parseBenchmarkManifest } from '../../src/core/benchmark/manifest.js';

describe('benchmark scoring', () => {
  it('calculates precision, recall, reciprocal rank and nDCG', () => {
    const score = scoreRankingObservation({
      id: 'case',
      expected: ['a.ts', 'b.ts'],
      actual: ['b.ts', 'noise.ts', 'a.ts'],
    });
    expect(score.precisionAtK).toBeCloseTo(2 / 3);
    expect(score.recallAtK).toBe(1);
    expect(score.reciprocalRank).toBe(1);
    expect(score.ndcg).toBeGreaterThan(0.7);
  });

  it('excludes unknown cases from aggregate metrics without deleting them', () => {
    const scores = [
      scoreRankingObservation({ id: 'known', expected: ['a'], actual: ['a'] }),
      scoreRankingObservation({ id: 'unknown', expected: [], actual: ['a'], unknown: true }),
    ];
    expect(aggregateRankingScores(scores)).toMatchObject({ cases: 2, evaluatedCases: 1, mrr: 1 });
  });

  it('rejects unknown manifest fields and preserves a typed schema boundary', () => {
    expect(() =>
      parseBenchmarkManifest({
        version: 1,
        name: 'x',
        license: 'MIT',
        access: 'fixture',
        cases: [],
        extra: true,
      }),
    ).toThrow();
  });
});
