import { describe, it, expect } from 'vitest';
import { searchSemantic } from '../../../src/core/search/semantic.js';
import type { IntentQuery } from '../../../src/core/search/types.js';

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

describe('searchSemantic', () => {
  /**
   * Deterministic embedding generator for testing.
   * Generates a vector based on character codes so the same text
   * always produces the same embedding. Uses a hash-based approach
   * to ensure different texts produce distinguishable vectors.
   */
  const mockEmbeddingGenerator = async (text: string): Promise<number[]> => {
    const dim = 16;
    const vec = new Array(dim).fill(0);
    // Use a simple hash-based approach for better distribution
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const idx = (code * (i + 1)) % dim;
      vec[idx] += (code % 100) / 100;
    }
    // Normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  };

  const mockCosineSimilarity = (a: number[], b: number[]): number => cosineSimilarity(a, b);

  describe('basic search with known embeddings', () => {
    it('returns results sorted by score descending', async () => {
      const fileEmbeddings = new Map<string, number[]>([
        ['src/auth/login.ts', await mockEmbeddingGenerator('auth login')],
        ['src/utils/math.ts', await mockEmbeddingGenerator('math utility')],
        ['src/auth/logout.ts', await mockEmbeddingGenerator('auth logout')],
      ]);

      const results = await searchSemantic(
        'auth login',
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { limit: 10, threshold: 0 }
      );

      expect(results.length).toBeGreaterThan(0);
      // Scores should be sorted descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('finds the most similar file for a query', async () => {
      // Use pre-computed embeddings where the query is identical to one file
      const queryEmbedding = await mockEmbeddingGenerator('authentication login user');
      const fileEmbeddings = new Map<string, number[]>([
        ['src/auth/login.ts', queryEmbedding], // identical to query → score 1.0
        ['src/utils/math.ts', await mockEmbeddingGenerator('calculate sum divide')],
        ['src/db/query.ts', await mockEmbeddingGenerator('database sql select')],
      ]);

      const results = await searchSemantic(
        'authentication login user',
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { limit: 10, threshold: 0 }
      );

      expect(results.length).toBeGreaterThan(0);
      // The auth file should be the top result (identical embedding → score 1.0)
      expect(results[0].filePath).toBe('src/auth/login.ts');
      expect(results[0].score).toBeCloseTo(1, 5);
    });

    it('accepts IntentQuery with naturalLanguage', async () => {
      const fileEmbeddings = new Map<string, number[]>([
        ['src/a.ts', await mockEmbeddingGenerator('hello world')],
      ]);

      const query: IntentQuery = { naturalLanguage: 'hello' };
      const results = await searchSemantic(
        query,
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { limit: 10, threshold: 0 }
      );

      expect(results.length).toBeGreaterThan(0);
    });

    it('accepts IntentQuery with deprecated text alias', async () => {
      const fileEmbeddings = new Map<string, number[]>([
        ['src/a.ts', await mockEmbeddingGenerator('hello world')],
      ]);

      const query: IntentQuery = { text: 'hello' };
      const results = await searchSemantic(
        query,
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { limit: 10, threshold: 0 }
      );

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('similarity threshold filtering', () => {
    it('filters out results below threshold', async () => {
      const fileEmbeddings = new Map<string, number[]>([
        ['src/similar.ts', await mockEmbeddingGenerator('exact match query')],
        ['src/different.ts', await mockEmbeddingGenerator('completely unrelated content xyz')],
      ]);

      // Use a high threshold that only the similar file passes
      const results = await searchSemantic(
        'exact match query',
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { limit: 10, threshold: 0.9 }
      );

      // Only the very similar file should pass the high threshold
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.9);
      }
    });

    it('returns empty array when no results meet threshold', async () => {
      const fileEmbeddings = new Map<string, number[]>([
        ['src/a.ts', await mockEmbeddingGenerator('abc def ghi')],
        ['src/b.ts', await mockEmbeddingGenerator('xyz uvw rst')],
      ]);

      const results = await searchSemantic(
        'completely different query',
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { limit: 10, threshold: 0.99 }
      );

      expect(results).toEqual([]);
    });

    it('uses default threshold of 0.7 when not specified', async () => {
      const fileEmbeddings = new Map<string, number[]>([
        ['src/a.ts', await mockEmbeddingGenerator('test content')],
      ]);

      // With default threshold 0.7, results below 0.7 should be excluded
      const results = await searchSemantic(
        'test content',
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { limit: 10 }
      );

      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.7);
      }
    });
  });

  describe('max results limiting', () => {
    it('limits results to specified count', async () => {
      const fileEmbeddings = new Map<string, number[]>();
      for (let i = 0; i < 20; i++) {
        fileEmbeddings.set(`src/file-${i}.ts`, await mockEmbeddingGenerator(`file content ${i}`));
      }

      const results = await searchSemantic(
        'file content',
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { limit: 5, threshold: 0 }
      );

      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('uses default limit of 5 when not specified', async () => {
      const fileEmbeddings = new Map<string, number[]>();
      for (let i = 0; i < 20; i++) {
        fileEmbeddings.set(`src/file-${i}.ts`, await mockEmbeddingGenerator(`file content ${i}`));
      }

      const results = await searchSemantic(
        'file content',
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { threshold: 0 }
      );

      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('returns all results when limit exceeds available matches', async () => {
      const fileEmbeddings = new Map<string, number[]>([
        ['src/a.ts', await mockEmbeddingGenerator('alpha')],
        ['src/b.ts', await mockEmbeddingGenerator('beta')],
      ]);

      const results = await searchSemantic(
        'alpha beta',
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { limit: 100, threshold: 0 }
      );

      expect(results.length).toBe(2);
    });
  });

  describe('empty query handling', () => {
    it('returns empty array for empty string query (default threshold filters 0)', async () => {
      const fileEmbeddings = new Map<string, number[]>([
        ['src/a.ts', await mockEmbeddingGenerator('some content')],
      ]);

      const results = await searchSemantic(
        '',
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { limit: 10 }
      );

      // Empty query produces zero vector → cosine similarity is 0 for all
      // Default threshold is 0.7, so 0-score results are filtered out
      expect(results).toEqual([]);
    });

    it('returns empty array for IntentQuery with empty naturalLanguage', async () => {
      const fileEmbeddings = new Map<string, number[]>([
        ['src/a.ts', await mockEmbeddingGenerator('some content')],
      ]);

      const query: IntentQuery = { naturalLanguage: '' };
      const results = await searchSemantic(
        query,
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { limit: 10 }
      );

      expect(results).toEqual([]);
    });

    it('returns empty array for IntentQuery with no text fields', async () => {
      const fileEmbeddings = new Map<string, number[]>([
        ['src/a.ts', await mockEmbeddingGenerator('some content')],
      ]);

      const query: IntentQuery = { structuralHints: ['auth'] };
      const results = await searchSemantic(
        query,
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { limit: 10 }
      );

      expect(results).toEqual([]);
    });
  });

  describe('with mock vector index', () => {
    it('handles empty file embeddings map', async () => {
      const fileEmbeddings = new Map<string, number[]>();

      const results = await searchSemantic(
        'any query',
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { limit: 10, threshold: 0 }
      );

      expect(results).toEqual([]);
    });

    it('returns correct filePath for each result', async () => {
      const fileEmbeddings = new Map<string, number[]>([
        ['src/auth/login.ts', await mockEmbeddingGenerator('login auth')],
        ['src/auth/logout.ts', await mockEmbeddingGenerator('logout auth')],
        ['src/utils/helper.ts', await mockEmbeddingGenerator('helper util')],
      ]);

      const results = await searchSemantic(
        'login auth',
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { limit: 10, threshold: 0 }
      );

      const paths = results.map((r) => r.filePath);
      expect(paths).toContain('src/auth/login.ts');
      expect(paths).toContain('src/auth/logout.ts');
      expect(paths).toContain('src/utils/helper.ts');
    });

    it('each result has a score between 0 and 1', async () => {
      const fileEmbeddings = new Map<string, number[]>([
        ['src/a.ts', await mockEmbeddingGenerator('content a')],
        ['src/b.ts', await mockEmbeddingGenerator('content b')],
        ['src/c.ts', await mockEmbeddingGenerator('content c')],
      ]);

      const results = await searchSemantic(
        'content',
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { limit: 10, threshold: 0 }
      );

      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }
    });

    it('identical query and embedding yields score of 1', async () => {
      const fileEmbeddings = new Map<string, number[]>([
        ['src/identical.ts', await mockEmbeddingGenerator('identical text')],
      ]);

      const results = await searchSemantic(
        'identical text',
        mockEmbeddingGenerator,
        mockCosineSimilarity,
        fileEmbeddings,
        { limit: 10, threshold: 0 }
      );

      expect(results.length).toBe(1);
      expect(results[0].score).toBeCloseTo(1, 5);
    });
  });
});
