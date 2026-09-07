import { existsSync } from 'node:fs';
import { loadConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { VectorIndex } from '../core/embeddings/vector-index.js';
import {
  generateCodebertEmbedding,
  generateOpenaiEmbedding,
  generateTransformersEmbedding,
  generateUnixcoderEmbedding,
  type InferenceSession,
  type TransformerPipeline,
} from './embedding-providers.js';

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

let transformersPipeline: TransformerPipeline | null = null;

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
    embedding = await generateTransformersEmbedding(text, dim, transformersPipeline);
  } else if (currentProvider === 'openai' && openaiApiKey) {
    embedding = await generateOpenaiEmbedding(text, openaiApiKey, openaiModel);
  } else if (currentProvider === 'unixcoder' && unixcoderSession) {
    embedding = await generateUnixcoderEmbedding(text, dim, unixcoderSession);
  } else if (currentProvider === 'codebert' && codebertSession) {
    embedding = await generateCodebertEmbedding(text, dim, codebertSession);
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
