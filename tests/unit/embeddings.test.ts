import { describe, it, expect } from 'vitest';
import {
  clearEmbeddingCache,
  codeToEmbedding,
  cosineSimilarity,
  findSimilar,
  generateEmbeddingBatch,
  getCurrentProvider,
  initEmbeddingProvider,
  textToEmbedding,
} from '../../src/parser/embeddings.js';
import { generateOpenaiEmbedding } from '../../src/parser/embedding-providers.js';

describe('Embeddings - cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it('returns 0 for vectors of different lengths', () => {
    const a = [1, 0];
    const b = [1, 0, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 instead of NaN for non-finite vectors', () => {
    expect(cosineSimilarity([Number.NaN], [1])).toBe(0);
    expect(cosineSimilarity([Number.POSITIVE_INFINITY], [1])).toBe(0);
  });
});

describe('Embeddings - textToEmbedding', () => {
  it('produces a vector of correct dimension', () => {
    const dim = 768;
    const vector = textToEmbedding('hello world', dim);
    expect(vector).toHaveLength(dim);
  });

  it('produces normalized vectors', () => {
    const vector = textToEmbedding('test text');
    const magnitude = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it('produces similar embeddings for anagrams', () => {
    const a = textToEmbedding('hello world');
    const b = textToEmbedding('world hello');
    const similarity = cosineSimilarity(a, b);
    expect(similarity).toBeGreaterThan(0.5);
  });

  it('produces different embeddings for different texts', () => {
    const a = textToEmbedding('hello world');
    const b = textToEmbedding('completely different text');
    const similarity = cosineSimilarity(a, b);
    expect(similarity).toBeLessThan(0.95);
  });

  it('handles empty string', () => {
    const vector = textToEmbedding('');
    expect(vector).toHaveLength(768);
    // All zeros for empty string
    const magnitude = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    expect(magnitude).toBe(0);
  });

  it('keeps token cache entries isolated by dimension', () => {
    clearEmbeddingCache();

    const short = textToEmbedding('dimension-safe token', 8);
    const long = textToEmbedding('dimension-safe token', 32);
    const shortAgain = textToEmbedding('dimension-safe token', 8);

    expect(short).toHaveLength(8);
    expect(long).toHaveLength(32);
    expect(shortAgain).toEqual(short);
    expect(long.every(Number.isFinite)).toBe(true);
    expect(short.every(Number.isFinite)).toBe(true);

    clearEmbeddingCache();
  });
});

describe('Embeddings - provider initialization', () => {
  it('is idempotent for the complete simple-provider configuration', async () => {
    const first = await initEmbeddingProvider({ provider: 'simple', dimension: 8 });
    const second = await initEmbeddingProvider({ provider: 'simple', dimension: 32 });

    expect(first.provider).toBe('simple');
    expect(first.fellBack).toBe(false);
    expect(second.provider).toBe('simple');
    expect(second.reinitialized).toBe(false);
    expect(getCurrentProvider()).toBe('simple');
  });

  it('processes every item when a batch crosses the provider safety cap', async () => {
    await initEmbeddingProvider({ provider: 'simple' });
    const texts = Array.from({ length: 35 }, (_, index) => `batch item ${index}`);
    const vectors = await generateEmbeddingBatch(texts, 16);

    expect(vectors).toHaveLength(texts.length);
    expect(vectors.every((vector) => vector.length === 16)).toBe(true);
  });

  it('sends requested dimensions only to OpenAI v3 embedding models', async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      await generateOpenaiEmbedding('x', 'test-key', 'text-embedding-3-small', 3);
      await generateOpenaiEmbedding('x', 'test-key', 'text-embedding-ada-002', 3);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestBodies[0]).toMatchObject({ model: 'text-embedding-3-small', dimensions: 3 });
    expect(requestBodies[1]).not.toHaveProperty('dimensions');
  });
});

describe('Embeddings - codeToEmbedding', () => {
  it('strips comments before embedding', () => {
    const withComments = codeToEmbedding('// comment\nfunction test() { return 1; }');
    const withoutComments = codeToEmbedding('function test() { return 1; }');
    const similarity = cosineSimilarity(withComments, withoutComments);
    expect(similarity).toBeGreaterThan(0.8);
  });

  it('handles empty code', () => {
    const vector = codeToEmbedding('');
    expect(vector).toHaveLength(768);
  });
});

describe('Embeddings - findSimilar', () => {
  it('finds similar candidates above threshold', () => {
    const target = textToEmbedding('hello world');
    const candidates = [
      { id: 1, embedding: textToEmbedding('world hello') },
      { id: 2, embedding: textToEmbedding('completely different') },
      { id: 3, embedding: textToEmbedding('hello') },
    ];

    const results = findSimilar(target, candidates, 0.5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe(1);
  });

  it('returns empty array when no candidates match', () => {
    const target = textToEmbedding('hello');
    const candidates = [{ id: 1, embedding: textToEmbedding('xyz') }];

    const results = findSimilar(target, candidates, 0.99);
    expect(results).toHaveLength(0);
  });

  it('respects the limit parameter', () => {
    const target = textToEmbedding('hello');
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      embedding: textToEmbedding('hello'),
    }));

    const results = findSimilar(target, candidates, 0.5, 5);
    expect(results).toHaveLength(5);
  });
});
