import { describe, expect, it } from 'vitest';
import { decodeEmbedding, encodeEmbedding } from '../../../src/core/embeddings/embedding-codec.js';

describe('embedding codec', () => {
  it('round-trips finite values through the compact BLOB format', () => {
    const values = [1, -0.25, 0, 42.5];
    expect(decodeEmbedding(encodeEmbedding(values))).toEqual(values);
  });

  it('reads legacy JSON text, including numeric strings', () => {
    expect(decodeEmbedding('[1,"2",0]')).toEqual([1, 2, 0]);
  });

  it('rejects malformed, truncated, empty, and non-finite values', () => {
    expect(decodeEmbedding('{"embedding":[]}')).toEqual([]);
    expect(decodeEmbedding('[1,null,3]')).toEqual([]);
    expect(decodeEmbedding('[1e999]')).toEqual([]);
    expect(decodeEmbedding(new Uint8Array([1, 2, 3]))).toEqual([]);
    expect(() => encodeEmbedding([1, Number.NaN])).toThrow(RangeError);
  });
});
