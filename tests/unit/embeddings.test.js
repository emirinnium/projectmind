import { describe, it, expect } from 'vitest';
import { cosineSimilarity, textToEmbedding, codeToEmbedding, findSimilar } from '../../src/parser/embeddings.js';
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
        const candidates = [
            { id: 1, embedding: textToEmbedding('xyz') },
        ];
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
//# sourceMappingURL=embeddings.test.js.map