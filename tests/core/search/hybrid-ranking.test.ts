import { describe, expect, it } from 'vitest';
import { lexicalRelevance, rankHybrid } from '../../../src/core/search/hybrid-ranking.js';

describe('hybrid retrieval ranking', () => {
  it('combines lexical, vector, graph and history signals deterministically', () => {
    const input = {
      query: 'authentication token',
      filePath: 'src/auth/token.ts',
      content: 'export function authenticationToken() { return token; }',
      vectorScore: 0.8,
      graphScore: 0.6,
      historyScore: 0.9,
    };
    expect(rankHybrid(input)).toEqual(rankHybrid(input));
    expect(rankHybrid(input).whyThisResult.join(' ')).toContain('lexical');
    expect(rankHybrid(input).total).toBeGreaterThan(0.5);
  });

  it('uses a neutral history prior for new files and never emits out-of-range scores', () => {
    expect(lexicalRelevance('unknown', 'src/a.ts', '')).toBe(0);
    const result = rankHybrid({
      query: 'unknown',
      filePath: 'src/a.ts',
      content: '',
      vectorScore: Number.NaN,
      graphScore: 4,
    });
    expect(result.history).toBe(0.5);
    expect(result.vector).toBe(0);
    expect(result.graph).toBe(1);
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(1);
  });
});
