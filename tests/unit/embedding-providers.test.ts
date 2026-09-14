import { describe, expect, it } from 'vitest';
import {
  generateCodebertEmbedding,
  generateTransformersEmbedding,
  generateUnixcoderEmbedding,
  type InferenceSession,
  type OnnxTokenizer,
} from '../../src/parser/embedding-providers.js';
import { MAX_EMBEDDING_TOKENS } from '../../src/parser/embedding-settings.js';

function tokenizer(): OnnxTokenizer {
  return async () => ({
    input_ids: { data: Array.from({ length: MAX_EMBEDDING_TOKENS }, (_, i) => (i === 0 ? 101 : 0)) },
    attention_mask: {
      data: Array.from({ length: MAX_EMBEDDING_TOKENS }, (_, i) => (i === 0 ? 1 : 0)),
    },
  });
}

describe('model-backed embedding adapters', () => {
  it('uses tokenizer-produced IDs and validates UniXcoder dimensions', async () => {
    let received: Record<string, { data: ArrayLike<number | bigint>; dims: number[] }> | undefined;
    const session: InferenceSession = {
      run: async (feeds) => {
        received = feeds;
        return { last_hidden_state: { data: new Float32Array(MAX_EMBEDDING_TOKENS * 4).fill(1) } };
      },
    };
    const vector = await generateUnixcoderEmbedding('source', 4, session, tokenizer());

    expect(vector).toHaveLength(4);
    expect(received?.input_ids.data[0]).toBe(101n);
    expect(received?.attention_mask.data[1]).toBe(0n);
  });

  it('rejects a model output dimension mismatch instead of padding it', async () => {
    const session: InferenceSession = {
      run: async () => ({ pooler_output: { data: new Float32Array([1, 2, 3]) } }),
    };
    await expect(generateCodebertEmbedding('source', 4, session, tokenizer())).rejects.toThrow(
      /does not match configured dimension/,
    );
    await expect(
      generateTransformersEmbedding('source', 4, async () => ({ data: new Float32Array([1, 2, 3]) })),
    ).rejects.toThrow(/does not match configured dimension/);
  });
});
