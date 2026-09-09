/** Clamp an observed similarity into the public 0..1 score range. */
export function safeScore(score: number | undefined): number | undefined {
  if (score === undefined || !Number.isFinite(score)) return undefined;
  return Math.max(0, Math.min(1, score));
}

/** Cosine similarity that is total over malformed, empty, or zero vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return 0;
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0 || !Number.isFinite(denominator)) return 0;
  const score = dot / denominator;
  return Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0;
}
