export interface EmbeddingVector {
  vector: number[];
  dimension: number;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function vectorDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

const EMBEDDING_DIM = 768; // Match v2 embedding dimension for consistency

const SIN_TABLE_SIZE = 10_000;
const SIN_TABLE = new Float32Array(SIN_TABLE_SIZE);
for (let i = 0; i < SIN_TABLE_SIZE; i++) {
  SIN_TABLE[i] = Math.sin((i / SIN_TABLE_SIZE) * Math.PI * 2);
}

const tokenVectorCache = new Map<string, Float32Array>();

export function textToEmbedding(text: string, dim: number = EMBEDDING_DIM): number[] {
  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = normalized.split(' ').filter((t) => t.length > 0);
  const vector = new Float32Array(dim);

  for (const token of tokens) {
    let cached = tokenVectorCache.get(token);
    if (!cached) {
      let hash = 0;
      for (let i = 0; i < token.length; i++) {
        hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
      }
      cached = new Float32Array(dim);
      for (let d = 0; d < dim; d++) {
        const idx = Math.abs((hash + d * 1000) % SIN_TABLE_SIZE);
        cached[d] = (SIN_TABLE[idx]! + 1) / 2;
      }
      if (tokenVectorCache.size > 10_000) {
        const firstKey = tokenVectorCache.keys().next().value;
        if (firstKey !== undefined) tokenVectorCache.delete(firstKey);
      }
      tokenVectorCache.set(token, cached);
    }
    for (let d = 0; d < dim; d++) {
      vector[d] += cached[d]!;
    }
  }

  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? Array.from(vector, (v) => v / norm) : Array.from(vector);
}

export function codeToEmbedding(code: string, dim: number = EMBEDDING_DIM): number[] {
  const normalized = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return textToEmbedding(normalized, dim);
}

export function findSimilar(
  embedding: number[],
  candidates: { id: number; embedding: number[] }[],
  threshold: number = 0.7,
  topK: number = 10,
): { id: number; score: number }[] {
  return candidates
    .map((c) => ({ id: c.id, score: cosineSimilarity(embedding, c.embedding) }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function clearEmbeddingCache(): void {
  tokenVectorCache.clear();
}

export function getEmbeddingCacheStats(): { size: number; maxSize: number } {
  return {
    size: tokenVectorCache.size,
    maxSize: 10_000,
  };
}
