import { AdvancedCache } from './advanced-cache.js';
import { stableHash } from '../../utils/hash.js';

/**
 * Specialized cache for code/text embeddings.
 *
 * Beyond the LRU+TTL+persistence base it adds:
 * - Single-flight `getOrCompute`: identical texts under concurrency embed
 *   once (embedding calls are the expensive path — provider or heuristic).
 * - Batch helpers for bulk indexing pipelines.
 * - Per-dimension statistics (768-dim UniXcoder vectors and 64-dim simple
 *   vectors never share keys, and now never blur the stats either).
 */
export class EmbeddingCache extends AdvancedCache<string, number[]> {
  private readonly inFlight = new Map<string, Promise<number[]>>();

  constructor(maxSize: number = 50_000, ttlMs: number = 86_400_000) {
    // 24 hours
    super({
      maxSize,
      ttlMs,
      persistent: true,
      persistPath: '.projectmind/embedding-cache.json',
    });
  }

  // NOTE: default dim kept for API compatibility; callers should pass the
  // real embedding dimension (768) so vectors of different dims never
  // share a key.
  makeKey(text: string, dim: number = 768): string {
    return `${dim}:${stableHash(text)}`;
  }

  /**
   * Cache-aside with single-flight: returns the cached vector, or computes
   * it exactly once even when several callers race the same text.
   */
  async getOrCompute(
    text: string,
    dim: number,
    compute: () => Promise<number[]> | number[],
  ): Promise<number[]> {
    const key = this.makeKey(text, dim);
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const flight = Promise.resolve()
      .then(compute)
      .then((vector) => {
        this.set(key, vector);
        return vector;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, flight);
    return flight;
  }

  /** Bulk read. Missing entries come back as undefined in order. */
  getBatch(texts: string[], dim: number): (number[] | undefined)[] {
    return texts.map((t) => this.get(this.makeKey(t, dim)));
  }

  /** Bulk write (single pass, LRU-aware via base set()). */
  setBatch(vectors: Array<{ text: string; dim: number; vector: number[] }>): void {
    for (const { text, dim, vector } of vectors) {
      this.set(this.makeKey(text, dim), vector);
    }
  }

  /** Entry count per embedding dimension currently held in memory. */
  dimensionStats(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const key of this.getKeys()) {
      const dim = typeof key === 'string' ? key.split(':', 1)[0] : 'unknown';
      counts[dim] = (counts[dim] ?? 0) + 1;
    }
    return counts;
  }
}
