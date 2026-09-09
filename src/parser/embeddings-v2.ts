import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
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

export interface EmbeddingInitResult {
  requestedProvider: EmbeddingProvider;
  provider: EmbeddingProvider;
  fellBack: boolean;
  reinitialized: boolean;
  limitations: string[];
}

let currentProvider: EmbeddingProvider = 'simple';
let unixcoderSession: InferenceSession | null = null;
let codebertSession: InferenceSession | null = null;
let openaiApiKey: string | undefined = undefined;
let openaiModel: string = 'text-embedding-3-small';

let transformersPipeline: TransformerPipeline | null = null;

interface RuntimeConfig {
  provider: EmbeddingProvider;
  modelPath?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  transformersModel?: string;
}

let activeRuntimeConfig: RuntimeConfig | null = null;
let activeLimitations: string[] = [];

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
    const configuredPath =
      provider === 'unixcoder'
        ? config.embeddings.unixcoderModelPath
        : config.embeddings.codebertModelPath;
    return isAbsolute(configuredPath)
      ? configuredPath
      : resolve(config.projectRoot, configuredPath);
  } catch {
    return resolve(
      process.cwd(),
      provider === 'unixcoder' ? 'models/unixcoder-base.onnx' : 'models/codebert-base.onnx',
    );
  }
}

function resolveRuntimeConfig(
  provider: EmbeddingProvider,
  options: EmbeddingOptions,
): RuntimeConfig {
  if (provider === 'openai') {
    return {
      provider,
      openaiApiKey: options.openaiApiKey || process.env.OPENAI_API_KEY,
      openaiModel: options.openaiModel || 'text-embedding-3-small',
    };
  }
  if (provider === 'transformers') {
    return {
      provider,
      transformersModel: options.transformersModel || 'Xenova/all-MiniLM-L6-v2',
    };
  }
  if (provider === 'unixcoder' || provider === 'codebert') {
    const configuredPath = options.modelPath || getDefaultModelPath(provider);
    return {
      provider,
      modelPath: isAbsolute(configuredPath)
        ? configuredPath
        : resolve(loadConfig().projectRoot, configuredPath),
    };
  }
  return { provider };
}

function runtimeConfigEquals(a: RuntimeConfig, b: RuntimeConfig): boolean {
  return (
    a.provider === b.provider &&
    a.modelPath === b.modelPath &&
    a.openaiApiKey === b.openaiApiKey &&
    a.openaiModel === b.openaiModel &&
    a.transformersModel === b.transformersModel
  );
}

function fallbackLimitations(
  requestedProvider: EmbeddingProvider,
  provider: EmbeddingProvider,
): string[] {
  return [
    `Requested provider "${requestedProvider}" was unavailable and the runtime is using "${provider}" instead.`,
    'The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.',
  ];
}

function initResult(
  requestedProvider: EmbeddingProvider,
  reinitialized: boolean,
): EmbeddingInitResult {
  return {
    requestedProvider,
    provider: currentProvider,
    fellBack: currentProvider !== requestedProvider,
    reinitialized,
    limitations: [...activeLimitations],
  };
}

function activateRuntime(config: RuntimeConfig, limitations: string[] = []): void {
  activeRuntimeConfig = config;
  activeLimitations = [...limitations];
}

function resetProviderState(): void {
  currentProvider = 'simple';
  unixcoderSession = null;
  codebertSession = null;
  transformersPipeline = null;
  openaiApiKey = undefined;
  openaiModel = 'text-embedding-3-small';
}

/**
 * Initialize the embedding provider.
 *
 * Initialization is idempotent for the complete runtime configuration, not
 * merely the provider name. This prevents a second request with a different
 * model, API key, or model path from silently reusing stale state while also
 * keeping repeated MCP/CLI initialization calls cheap.
 */
export async function initEmbeddingProvider(
  options: EmbeddingOptions = {},
): Promise<EmbeddingInitResult> {
  const provider = options.provider || 'simple';
  const config = resolveRuntimeConfig(provider, options);
  const sameConfiguration =
    activeRuntimeConfig !== null && runtimeConfigEquals(config, activeRuntimeConfig);

  if (sameConfiguration) {
    logger.debug(`Embedding provider already initialized: ${provider} (skipping re-init)`);
    return initResult(provider, false);
  }

  const reinitialized = activeRuntimeConfig !== null;
  resetProviderState();

  if (provider === 'simple') {
    activateRuntime(config);
    return initResult(provider, reinitialized);
  }

  if (provider === 'openai') {
    openaiApiKey = config.openaiApiKey;
    openaiModel = config.openaiModel || 'text-embedding-3-small';
    if (!openaiApiKey) {
      const limitations = fallbackLimitations(provider, 'simple');
      logger.warn('OpenAI API key not provided, falling back to simple embeddings');
      activateRuntime(config, limitations);
      return initResult(provider, reinitialized);
    }
    currentProvider = 'openai';
    activateRuntime(config);
    logger.info(`OpenAI embedding provider initialized (model: ${openaiModel})`);
    return initResult(provider, reinitialized);
  }

  if (provider === 'transformers') {
    try {
      const modelName = config.transformersModel || 'Xenova/all-MiniLM-L6-v2';
      const { pipeline } = await import('@xenova/transformers');
      transformersPipeline = (await pipeline(
        'feature-extraction',
        modelName,
      )) as TransformerPipeline;
      currentProvider = 'transformers';
      activateRuntime(config);
      logger.info(`Transformers.js embedding provider initialized (model: ${modelName})`);
    } catch (e) {
      const limitations = fallbackLimitations(provider, 'simple');
      logger.warn(
        `Failed to initialize Transformers.js, falling back to simple embeddings: ${e instanceof Error ? e.message : String(e)}`,
      );
      activateRuntime(config, limitations);
      return initResult(provider, reinitialized);
    }
    return initResult(provider, reinitialized);
  }

  if (provider === 'unixcoder' || provider === 'codebert') {
    try {
      const ortModule = (await getOrtModule()) as {
        InferenceSession: new (path: string) => InferenceSession;
      } | null;
      if (!ortModule) {
        const limitations = fallbackLimitations(provider, 'simple');
        logger.warn('onnxruntime-node not installed, falling back to simple embeddings');
        activateRuntime(config, limitations);
        return initResult(provider, reinitialized);
      }
      const modelPath = config.modelPath!;
      if (!existsSync(modelPath)) {
        const limitations = fallbackLimitations(provider, 'simple');
        logger.warn(
          `${provider === 'unixcoder' ? 'UniXcoder' : 'CodeBERT'} model not found at ${modelPath}, falling back to simple embeddings`,
        );
        activateRuntime(config, limitations);
        return initResult(provider, reinitialized);
      }
      const session = new ortModule.InferenceSession(modelPath);
      if (provider === 'unixcoder') unixcoderSession = session;
      else codebertSession = session;
      currentProvider = provider;
      activateRuntime(config);
      logger.info(
        `${provider === 'unixcoder' ? 'UniXcoder' : 'CodeBERT'} embedding provider initialized`,
      );
    } catch (e) {
      const limitations = fallbackLimitations(provider, 'simple');
      logger.warn(
        `Failed to initialize ${provider === 'unixcoder' ? 'UniXcoder' : 'CodeBERT'}, falling back to simple embeddings: ${e instanceof Error ? e.message : String(e)}`,
      );
      activateRuntime(config, limitations);
    }
    return initResult(provider, reinitialized);
  }

  throw new Error(`Unknown embedding provider: ${provider}`);
}

/**
 * Initialize the provider selected by project configuration when this
 * process has not deliberately selected another non-simple provider yet.
 * Returning null for a simple config or an already-active provider keeps this
 * helper safe for scanners, CLI searches, and MCP startup alike.
 */
export async function initializeConfiguredEmbeddingProvider(): Promise<EmbeddingInitResult | null> {
  const embeddings = loadConfig().embeddings;
  if (embeddings.provider === 'simple' || currentProvider !== 'simple') return null;

  return initEmbeddingProvider({
    provider: embeddings.provider,
    dimension: embeddings.dimension,
    modelPath:
      embeddings.provider === 'unixcoder'
        ? embeddings.unixcoderModelPath
        : embeddings.provider === 'codebert'
          ? embeddings.codebertModelPath
          : undefined,
    openaiApiKey: embeddings.openaiApiKey,
    openaiModel: embeddings.openaiModel,
    transformersModel: embeddings.transformersModel,
  });
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
    embedding = await generateOpenaiEmbedding(text, openaiApiKey, openaiModel, dim);
  } else if (currentProvider === 'unixcoder' && unixcoderSession) {
    embedding = await generateUnixcoderEmbedding(text, dim, unixcoderSession);
  } else if (currentProvider === 'codebert' && codebertSession) {
    embedding = await generateCodebertEmbedding(text, dim, codebertSession);
  } else {
    // Fallback to simple embedding
    const { codeToEmbedding } = await import('./legacy-embeddings.js');
    embedding = codeToEmbedding(text, dim);
  }

  if (embedding.length === 0 || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error(`Embedding provider returned an invalid vector (length=${embedding.length})`);
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
  const out: number[][] = [];
  // Keep each provider/session batch bounded without silently dropping the
  // tail when a caller submits more than MAX_EMBEDDING_BATCH items.
  for (let offset = 0; offset < texts.length; offset += MAX_EMBEDDING_BATCH) {
    const chunk = texts.slice(offset, offset + MAX_EMBEDDING_BATCH);
    for (let i = 0; i < chunk.length; i++) {
      out.push(await generateEmbedding(chunk[i]!, dim, opts.indexIds?.[offset + i], opts.metadata));
    }
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
