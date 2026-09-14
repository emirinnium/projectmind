import { MAX_EMBEDDING_TOKENS } from './embedding-settings.js';

export type InferenceSession = {
  run(
    feeds: Record<string, { data: Float32Array | Int32Array | BigInt64Array; dims: number[] }>,
  ): Promise<{
    last_hidden_state?: { data: Float32Array };
    pooler_output?: { data: Float32Array };
  }>;
};

export interface OnnxTokenizerOutput {
  input_ids?: { data: ArrayLike<number | bigint> };
  attention_mask?: { data: ArrayLike<number | bigint> };
}

export type OnnxTokenizer = (
  text: string,
  options?: { padding?: 'max_length'; truncation?: boolean; max_length?: number },
) => Promise<OnnxTokenizerOutput> | OnnxTokenizerOutput;

export type TransformerPipeline = (
  text: string,
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array }>;

export async function generateUnixcoderEmbedding(
  text: string,
  dim: number,
  session: InferenceSession,
  tokenizer: OnnxTokenizer,
): Promise<number[]> {
  const { inputIds, attentionMask } = await tokenizeForOnnx(text, tokenizer);

  const results = await session.run({
    input_ids: { data: inputIds, dims: [1, MAX_EMBEDDING_TOKENS] },
    attention_mask: { data: attentionMask, dims: [1, MAX_EMBEDDING_TOKENS] },
  });
  const output = results.last_hidden_state;
  if (!output) throw new Error('UniXcoder output missing last_hidden_state');
  const nativeDimension = output.data.length / MAX_EMBEDDING_TOKENS;
  if (!Number.isSafeInteger(nativeDimension) || nativeDimension !== dim) {
    throw new Error(
      `UniXcoder output dimension ${nativeDimension} does not match configured dimension ${dim}. Configure embeddings.dimension to the model dimension.`,
    );
  }

  const embedding = new Array<number>(dim).fill(0);
  for (let i = 0; i < MAX_EMBEDDING_TOKENS; i++) {
    if (attentionMask[i] === 1n) {
      for (let j = 0; j < dim; j++) embedding[j] += output.data[i * dim + j]!;
    }
  }

  return normalizeEmbedding(embedding);
}

export async function generateCodebertEmbedding(
  text: string,
  dim: number,
  session: InferenceSession,
  tokenizer: OnnxTokenizer,
): Promise<number[]> {
  const { inputIds, attentionMask } = await tokenizeForOnnx(text, tokenizer);

  const results = await session.run({
    input_ids: { data: inputIds, dims: [1, MAX_EMBEDDING_TOKENS] },
    attention_mask: { data: attentionMask, dims: [1, MAX_EMBEDDING_TOKENS] },
  });
  const output = results.pooler_output;
  if (!output) throw new Error('CodeBERT output missing pooler_output');
  if (output.data.length !== dim) {
    throw new Error(
      `CodeBERT output dimension ${output.data.length} does not match configured dimension ${dim}. Configure embeddings.dimension to the model dimension.`,
    );
  }

  return normalizeEmbedding(Array.from(output.data));
}

export async function generateTransformersEmbedding(
  text: string,
  dim: number,
  pipeline: TransformerPipeline,
): Promise<number[]> {
  const result = await pipeline(text, { pooling: 'mean', normalize: true });
  if (result.data.length !== dim) {
    throw new Error(
      `Transformers output dimension ${result.data.length} does not match configured dimension ${dim}. Configure embeddings.dimension to the model dimension.`,
    );
  }
  return Array.from(result.data);
}

export async function generateOpenaiEmbedding(
  text: string,
  apiKey: string,
  model: string,
  dimension?: number,
): Promise<number[]> {
  const requestBody: { model: string; input: string; dimensions?: number } = {
    model,
    input: text.slice(0, 8191),
  };
  // The v3 embedding models support server-side dimensionality reduction.
  // Older models reject this field, so leave their request shape unchanged and
  // let the response's actual dimension be reported by the index manifest.
  if (dimension !== undefined && model.startsWith('text-embedding-3-')) {
    requestBody.dimensions = dimension;
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${error}`);
  }

  const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
  if (!data.data?.[0]?.embedding) throw new Error('OpenAI API returned invalid embedding data');
  return data.data[0].embedding;
}

function normalizeEmbedding(embedding: number[]): number[] {
  const norm = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? embedding.map((value) => value / norm) : embedding;
}

async function tokenizeForOnnx(
  text: string,
  tokenizer: OnnxTokenizer,
): Promise<{ inputIds: BigInt64Array; attentionMask: BigInt64Array }> {
  const output = await tokenizer(text, {
    padding: 'max_length',
    truncation: true,
    max_length: MAX_EMBEDDING_TOKENS,
  });
  const inputIds = toPaddedInt64(output.input_ids?.data, 'input_ids');
  const attentionMask = toPaddedInt64(output.attention_mask?.data, 'attention_mask');
  return { inputIds, attentionMask };
}

function toPaddedInt64(
  values: ArrayLike<number | bigint> | undefined,
  name: 'input_ids' | 'attention_mask',
): BigInt64Array {
  if (!values || values.length === 0 || values.length > MAX_EMBEDDING_TOKENS) {
    throw new Error(`ONNX tokenizer returned invalid ${name} length.`);
  }
  const result = new BigInt64Array(MAX_EMBEDDING_TOKENS);
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    try {
      result[index] = typeof value === 'bigint' ? value : BigInt(value);
    } catch {
      throw new Error(`ONNX tokenizer returned a non-integer ${name} value at index ${index}.`);
    }
  }
  return result;
}
