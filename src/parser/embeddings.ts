// Sync simple embeddings (backwards compatible)
export { cosineSimilarity, vectorDistance, findSimilar, clearEmbeddingCache, getEmbeddingCacheStats, codeToEmbedding, textToEmbedding } from './legacy-embeddings.js';
export type { EmbeddingVector } from './legacy-embeddings.js';

export type EmbeddingProvider = 'simple' | 'unixcoder' | 'codebert';

export interface EmbeddingOptions {
  provider?: EmbeddingProvider;
  dimension?: number;
  modelPath?: string;
}

// Advanced provider initialization
export { initEmbeddingProvider, getCurrentProvider } from './embeddings-v2.js';

/**
 * Async embedding generation with provider support.
 */
export async function generateEmbedding(text: string, dim: number = 768): Promise<number[]> {
  const { generateEmbedding: gen } = await import('./embeddings-v2.js');
  return gen(text, dim);
}

/**
 * Asynchronous code embedding with optional provider.
 */
export async function codeToEmbeddingAsync(code: string, dim: number = 768): Promise<number[]> {
  return generateEmbedding(code, dim);
}

/**
 * Asynchronous text embedding with optional provider.
 */
export async function textToEmbeddingAsync(text: string, dim: number = 768): Promise<number[]> {
  return generateEmbedding(text, dim);
}