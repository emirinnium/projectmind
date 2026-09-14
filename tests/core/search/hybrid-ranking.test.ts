import { describe, expect, it } from 'vitest';
import {
  lexicalRelevance,
  normalizeHybridRankingWeights,
  rankHybrid,
} from '../../../src/core/search/hybrid-ranking.js';

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

  it('matches camelCase and Unicode identifiers while keeping unrelated files low', () => {
    const relevant = lexicalRelevance(
      'rate limiting yapılandırması',
      'src/rateLimitConfig.ts',
      'export const rateLimitConfig = { yapılandırması: true };',
    );
    const unrelated = lexicalRelevance(
      'rate limiting yapılandırması',
      'src/logger.ts',
      'export function writeAuditLog(message: string) { return message; }',
    );

    expect(relevant).toBeGreaterThan(unrelated);
    expect(relevant).toBeGreaterThan(0.5);
    expect(unrelated).toBe(0);
  });

  it('normalizes valid weights and ignores invalid values without producing NaN', () => {
    const weights = normalizeHybridRankingWeights({
      lexical: 0,
      vector: 2,
      graph: Number.NaN,
      history: -1,
      freshness: 0,
    });
    expect(weights.lexical).toBe(0);
    expect(weights.vector).toBeGreaterThan(0);
    expect(weights.freshness).toBe(0);
    expect(Object.values(weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });

  it('lets callers change ranking priorities while keeping the result bounded', () => {
    const input = {
      query: 'authentication',
      filePath: 'src/auth.ts',
      content: 'export function authentication() {}',
      vectorScore: 0.1,
      graphScore: 0.1,
      historyScore: 0.1,
      freshnessScore: 1,
    };
    const lexicalOnly = rankHybrid(input, {
      lexical: 1,
      vector: 0,
      graph: 0,
      history: 0,
      freshness: 0,
    });
    const freshnessOnly = rankHybrid(input, {
      lexical: 0,
      vector: 0,
      graph: 0,
      history: 0,
      freshness: 1,
    });
    expect(lexicalOnly.total).toBeCloseTo(lexicalOnly.lexical, 2);
    expect(freshnessOnly.total).toBe(1);
    expect(lexicalOnly.total).toBeGreaterThan(freshnessOnly.total - 1);
    expect(lexicalOnly.total).toBeGreaterThanOrEqual(0);
    expect(lexicalOnly.total).toBeLessThanOrEqual(1);
  });

  it('uses an explicit neutral freshness prior when freshness is unavailable', () => {
    const result = rankHybrid({
      query: 'no match',
      filePath: 'src/a.ts',
      content: '',
      vectorScore: 0,
      graphScore: 0,
    });
    expect(result.freshness).toBe(0.5);
    expect(result.whyThisResult.join(' ')).toContain('freshness unavailable');
  });
});
