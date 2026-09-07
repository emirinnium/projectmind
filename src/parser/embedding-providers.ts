import { MAX_EMBEDDING_TOKENS } from './embedding-settings.js';

export type InferenceSession = {
  run(feeds: Record<string, { data: Float32Array | Int32Array; dims: number[] }>): Promise<{
    last_hidden_state?: { data: Float32Array };
    pooler_output?: { data: Float32Array };
  }>;
};

export type TransformerPipeline = (
  text: string,
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array }>;

export async function generateUnixcoderEmbedding(
  text: string,
  dim: number,
  session: InferenceSession,
): Promise<number[]> {
  const tokens = text.toLowerCase().split(/\s+/).slice(0, MAX_EMBEDDING_TOKENS);
  const inputIds = new Int32Array(MAX_EMBEDDING_TOKENS);
  const attentionMask = new Int32Array(MAX_EMBEDDING_TOKENS);

  for (let i = 0; i < MAX_EMBEDDING_TOKENS; i++) {
    if (i < tokens.length) {
      inputIds[i] = hashToken(tokens[i]!) % 50000;
      attentionMask[i] = 1;
    }
  }

  const results = await session.run({
    input_ids: { data: inputIds, dims: [1, MAX_EMBEDDING_TOKENS] },
    attention_mask: { data: attentionMask, dims: [1, MAX_EMBEDDING_TOKENS] },
  });
  const output = results.last_hidden_state;
  if (!output) throw new Error('UniXcoder output missing last_hidden_state');

  const embedding = new Array<number>(dim).fill(0);
  for (let i = 0; i < MAX_EMBEDDING_TOKENS; i++) {
    if (attentionMask[i] === 1) {
      for (let j = 0; j < dim; j++) embedding[j] += output.data[i * dim + j]!;
    }
  }

  return normalizeEmbedding(embedding);
}

export async function generateCodebertEmbedding(
  text: string,
  dim: number,
  session: InferenceSession,
): Promise<number[]> {
  const tokens = text.toLowerCase().split(/\s+/).slice(0, MAX_EMBEDDING_TOKENS);
  const inputIds = new Int32Array(MAX_EMBEDDING_TOKENS);
  const attentionMask = new Int32Array(MAX_EMBEDDING_TOKENS);

  for (let i = 0; i < MAX_EMBEDDING_TOKENS; i++) {
    if (i < tokens.length) {
      inputIds[i] = hashToken(tokens[i]!) % 30000;
      attentionMask[i] = 1;
    }
  }

  const results = await session.run({
    input_ids: { data: inputIds, dims: [1, MAX_EMBEDDING_TOKENS] },
    attention_mask: { data: attentionMask, dims: [1, MAX_EMBEDDING_TOKENS] },
  });
  const output = results.pooler_output;
  if (!output) throw new Error('CodeBERT output missing pooler_output');

  return normalizeEmbedding(Array.from(output.data).slice(0, dim));
}

export async function generateTransformersEmbedding(
  text: string,
  dim: number,
  pipeline: TransformerPipeline,
): Promise<number[]> {
  const result = await pipeline(text, { pooling: 'mean', normalize: true });
  const embedding = Array.from(result.data).slice(0, dim);
  while (embedding.length < dim) embedding.push(0);
  return embedding;
}

export async function generateOpenaiEmbedding(
  text: string,
  apiKey: string,
  model: string,
): Promise<number[]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text.slice(0, 8191) }),
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

function hashToken(token: string): number {
  let hash = 0;
  for (let i = 0; i < token.length; i++) hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
  return Math.abs(hash);
}
