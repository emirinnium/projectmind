import { existsSync } from 'node:fs';
import { loadConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { VectorIndex } from '../core/embeddings/vector-index.js';

// Re-export base utilities
export {
  cosineSimilarity,
  vectorDistance,
  findSimilar,
  clearEmbeddingCache,
  getEmbeddingCacheStats,
} from './legacy-embeddings.js';
export type { EmbeddingVector } from './legacy-embeddings.js';

// Global vector index
const vectorIndex = new VectorIndex();

// Maximum token count for text splitting and array initialization
const MAX_TOKENS_PER_CHUNK = 512;

export type EmbeddingProvider = 'simple' | 'openai' | 'transformers' | 'unixcoder' | 'codebert';

export interface EmbeddingOptions {
  provider?: EmbeddingProvider;
  dimension?: number;
  modelPath?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  transformersModel?: string;
}

let currentProvider: EmbeddingProvider = 'simple';
let unixcoderSession: InferenceSession | null = null;
let codebertSession: InferenceSession | null = null;
let openaiApiKey: string | undefined = undefined;
let openaiModel: string = 'text-embedding-3-small';

type TransformerPipeline = (
  text: string,
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array }>;
let transformersPipeline: TransformerPipeline | null = null;

type InferenceSession = {
  run(feeds: Record<string, { data: Float32Array | Int32Array; dims: number[] }>): Promise<{
    last_hidden_state?: { data: Float32Array };
    pooler_output?: { data: Float32Array };
  }>;
};

type OrtModule = { InferenceSession: new (path: string) => InferenceSession };

// Lazy-loaded ONNX module reference
let ortModulePromise: Promise<OrtModule | null> | null = null;

async function getOrtModule(): Promise<OrtModule | null> {
  if (!ortModulePromise) {
    ortModulePromise = import('onnxruntime-node').catch(() => null) as Promise<OrtModule | null>;
  }
  return ortModulePromise;
}

function getDefaultModelPath(provider: 'unixcoder' | 'codebert'): string {
  try {
    const config = loadConfig();
    return provider === 'unixcoder'
      ? config.embeddings.unixcoderModelPath
      : config.embeddings.codebertModelPath;
  } catch {
    return provider === 'unixcoder' ? 'models/unixcoder-base.onnx' : 'models/codebert-base.onnx';
  }
}

/**
 * Initialize the embedding provider
 *
 * K11/R15: idempotent for the SAME provider. Re-initializing mid-process
 * (e.g. two MCP tools both call init) silently switched providers before,
 * changing the embedding DIMENSION and corrupting the shared vec index
 * (split-brain). Only an explicit provider CHANGE re-initializes.
 */
export async function initEmbeddingProvider(options: EmbeddingOptions = {}): Promise<void> {
  const provider = options.provider || 'simple';

  if (provider === currentProvider) {
    if (provider !== 'simple') {
      logger.debug(`Embedding provider already initialized: ${provider} (skipping re-init)`);
    }
    return;
  }

  if (provider === 'simple') {
    currentProvider = 'simple';
    return;
  }

  if (provider === 'openai') {
    openaiApiKey = options.openaiApiKey || process.env.OPENAI_API_KEY;
    openaiModel = options.openaiModel || 'text-embedding-3-small';
    if (!openaiApiKey) {
      logger.warn('OpenAI API key not provided, falling back to simple embeddings');
      currentProvider = 'simple';
      return;
    }
    currentProvider = 'openai';
    logger.info(`OpenAI embedding provider initialized (model: ${openaiModel})`);
    return;
  }

  if (provider === 'transformers') {
    try {
      const modelName = options.transformersModel || 'Xenova/all-MiniLM-L6-v2';
      const { pipeline } = await import('@xenova/transformers');
      transformersPipeline = (await pipeline(
        'feature-extraction',
        modelName,
      )) as TransformerPipeline;
      currentProvider = 'transformers';
      logger.info(`Transformers.js embedding provider initialized (model: ${modelName})`);
    } catch (e) {
      logger.warn(
        `Failed to initialize Transformers.js, falling back to simple embeddings: ${e instanceof Error ? e.message : String(e)}`,
      );
      currentProvider = 'simple';
    }
    return;
  }

  if (provider === 'unixcoder') {
    try {
      const ortModule = (await getOrtModule()) as {
        InferenceSession: new (path: string) => InferenceSession;
      } | null;
      if (!ortModule) {
        logger.warn('onnxruntime-node not installed, falling back to simple embeddings');
        currentProvider = 'simple';
        return;
      }
      const modelPath = options.modelPath || getDefaultModelPath('unixcoder');
      if (!existsSync(modelPath)) {
        logger.warn(`UniXcoder model not found at ${modelPath}, falling back to simple embeddings`);
        currentProvider = 'simple';
        return;
      }
      unixcoderSession = new ortModule.InferenceSession(modelPath);
      currentProvider = 'unixcoder';
      logger.info('UniXcoder embedding provider initialized');
    } catch (e) {
      logger.warn(
        `Failed to initialize UniXcoder, falling back to simple embeddings: ${e instanceof Error ? e.message : String(e)}`,
      );
      currentProvider = 'simple';
    }
    return;
  }

  if (provider === 'codebert') {
    try {
      const ortModule = (await getOrtModule()) as {
        InferenceSession: new (path: string) => InferenceSession;
      } | null;
      if (!ortModule) {
        logger.warn('onnxruntime-node not installed, falling back to simple embeddings');
        currentProvider = 'simple';
        return;
      }
      const modelPath = options.modelPath || getDefaultModelPath('codebert');
      if (!existsSync(modelPath)) {
        logger.warn(`CodeBERT model not found at ${modelPath}, falling back to simple embeddings`);
        currentProvider = 'simple';
        return;
      }
      codebertSession = new ortModule.InferenceSession(modelPath);
      currentProvider = 'codebert';
      logger.info('CodeBERT embedding provider initialized');
    } catch (e) {
      logger.warn(
        `Failed to initialize CodeBERT, falling back to simple embeddings: ${e instanceof Error ? e.message : String(e)}`,
      );
      currentProvider = 'simple';
    }
    return;
  }

  throw new Error(`Unknown embedding provider: ${provider}`);
}

/**
 * Get the current embedding provider
 */
export function getCurrentProvider(): EmbeddingProvider {
  return currentProvider;
}

/**
 * Generate embedding for text using the current provider
 */
export async function generateEmbedding(
  text: string,
  dim: number = 768,
  indexId?: string,
  metadata?: Record<string, string | number | boolean | null>,
): Promise<number[]> {
  let embedding: number[];

  if (currentProvider === 'transformers' && transformersPipeline) {
    embedding = await generateTransformersEmbedding(text, dim);
  } else if (currentProvider === 'openai' && openaiApiKey) {
    embedding = await generateOpenAIEmbedding(text);
  } else if (currentProvider === 'unixcoder' && unixcoderSession) {
    embedding = await generateUniXcoderEmbedding(text, dim);
  } else if (currentProvider === 'codebert' && codebertSession) {
    embedding = await generateCodeBERTEmbedding(text, dim);
  } else {
    // Fallback to simple embedding
    const { codeToEmbedding } = await import('./legacy-embeddings.js');
    embedding = codeToEmbedding(text, dim);
  }

  // Add to vector index if indexId is provided
  if (indexId) {
    vectorIndex.addVector(indexId, embedding, metadata || {});
  }

  return embedding;
}

/**
 * K11/R15: hard cap for one batch — keeps the greedy scan/dedupe worker from
 * buffering an unbounded number of texts (and thus unbounded memory).
 */
export const MAX_EMBEDDING_BATCH = 32;

/**
 * K11/R15: batch embedding generation.
 *
 * Callers that produce N texts (scan, dedupe, coordination) MUST use this
 * instead of looping `generateEmbedding` themselves: ONNX/transformers
 * sessions are re-entered per call, and a naive loop defeats the single
 * provider/session architecture and can balloon memory. The batch is hard
 * capped at {@link MAX_EMBEDDING_BATCH}.
 */
export async function generateEmbeddingBatch(
  texts: readonly string[],
  dim: number = 768,
  opts: { indexIds?: string[]; metadata?: Record<string, string | number | boolean | null> } = {},
): Promise<number[][]> {
  const chunk = texts.slice(0, MAX_EMBEDDING_BATCH);
  const out: number[][] = [];
  for (let i = 0; i < chunk.length; i++) {
    out.push(await generateEmbedding(chunk[i]!, dim, opts.indexIds?.[i], opts.metadata));
  }
  return out;
}

/**
 * Find similar vectors in the index.
 */
export function findSimilarInIndex(
  queryVector: number[],
  limit: number = 5,
): Array<{
  id: string;
  score: number;
  metadata: Record<string, string | number | boolean | null>;
}> {
  return vectorIndex.findSimilar(queryVector, limit);
}

/**
 * Clear the vector index.
 */
export function clearVectorIndex(): void {
  vectorIndex.clear();
}

/**
 * Generate embedding using UniXcoder model
 */
async function generateUniXcoderEmbedding(text: string, dim: number): Promise<number[]> {
  if (!unixcoderSession) {
    throw new Error('UniXcoder session not initialized');
  }

  const tokens = text.toLowerCase().split(/\s+/).slice(0, MAX_TOKENS_PER_CHUNK);
  const inputIds = new Int32Array(MAX_TOKENS_PER_CHUNK);
  const attentionMask = new Int32Array(MAX_TOKENS_PER_CHUNK);

  for (let i = 0; i < MAX_TOKENS_PER_CHUNK; i++) {
    if (i < tokens.length) {
      inputIds[i] = hashToken(tokens[i]!) % 50000;
      attentionMask[i] = 1;
    } else {
      inputIds[i] = 0;
      attentionMask[i] = 0;
    }
  }

  const session = unixcoderSession as InferenceSession;
  const results = await session.run({
    input_ids: { data: inputIds, dims: [1, MAX_TOKENS_PER_CHUNK] },
    attention_mask: { data: attentionMask, dims: [1, MAX_TOKENS_PER_CHUNK] },
  });

  const output = results.last_hidden_state;
  if (!output) {
    throw new Error('UniXcoder output missing last_hidden_state');
  }

  const hiddenStates = output.data;
  const embedding = new Array(dim);
  for (let i = 0; i < dim; i++) {
    embedding[i] = 0;
  }

  for (let i = 0; i < MAX_TOKENS_PER_CHUNK; i++) {
    if (attentionMask[i] === 1) {
      for (let j = 0; j < dim; j++) {
        embedding[j] += hiddenStates[i * dim + j]!;
      }
    }
  }

  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? embedding.map((v) => v / norm) : embedding;
}

/**
 * Generate embedding using CodeBERT model
 */
async function generateCodeBERTEmbedding(text: string, dim: number): Promise<number[]> {
  if (!codebertSession) {
    throw new Error('CodeBERT session not initialized');
  }

  const tokens = text.toLowerCase().split(/\s+/).slice(0, MAX_TOKENS_PER_CHUNK);
  const inputIds = new Int32Array(MAX_TOKENS_PER_CHUNK);
  const attentionMask = new Int32Array(MAX_TOKENS_PER_CHUNK);

  for (let i = 0; i < MAX_TOKENS_PER_CHUNK; i++) {
    if (i < tokens.length) {
      inputIds[i] = hashToken(tokens[i]!) % 30000;
      attentionMask[i] = 1;
    } else {
      inputIds[i] = 0;
      attentionMask[i] = 0;
    }
  }

  const session = codebertSession as InferenceSession;
  const results = await session.run({
    input_ids: { data: inputIds, dims: [1, MAX_TOKENS_PER_CHUNK] },
    attention_mask: { data: attentionMask, dims: [1, MAX_TOKENS_PER_CHUNK] },
  });

  const output = results.pooler_output;
  if (!output) {
    throw new Error('CodeBERT output missing pooler_output');
  }

  const hiddenStates = output.data;
  const embedding = Array.from(hiddenStates).slice(0, dim);

  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? embedding.map((v) => v / norm) : embedding;
}

/**
 * Generate embedding using Transformers.js (local, no API key needed)
 */
async function generateTransformersEmbedding(text: string, dim: number): Promise<number[]> {
  if (!transformersPipeline) {
    throw new Error('Transformers.js pipeline not initialized');
  }

  const pipe = transformersPipeline as (
    text: string,
    options?: { pooling?: string; normalize?: boolean },
  ) => Promise<{ data: Float32Array }>;
  const result = await pipe(text, { pooling: 'mean', normalize: true });
  const embedding = Array.from(result.data).slice(0, dim);

  // Pad or truncate to requested dimension
  while (embedding.length < dim) {
    embedding.push(0);
  }

  return embedding;
}

/**
 * Generate embedding using OpenAI API
 */
async function generateOpenAIEmbedding(text: string): Promise<number[]> {
  if (!openaiApiKey) {
    throw new Error('OpenAI API key not initialized');
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: openaiModel,
      input: text.slice(0, 8191), // OpenAI token limit
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${error}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  if (!data?.data?.[0]?.embedding) {
    throw new Error('OpenAI API returned invalid embedding data');
  }
  return data.data[0].embedding;
}

/**
 * Simple hash function for tokenization fallback
 */
function hashToken(token: string): number {
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}
