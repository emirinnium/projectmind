import { AdvancedCache } from './advanced-cache.js';
import type { CoherenceResult } from '../coherence/engine.js';
import { stableHash } from '../../utils/hash.js';

/**
 * Specialized cache for coherence analysis results.
 *
 * Beyond the LRU+TTL+persistence base it adds:
 * - Single-flight `getOrCompute`: concurrent checks of the SAME code/file
 *   share one computation instead of stampeding the analyzer.
 * - File-scoped invalidation (`invalidateFile`): drop every cached verdict
 *   for a path when its content changes, regardless of code hash.
 * - Proactive `pruneExpired` so persisted caches do not rot on disk.
 */
export class CoherenceCache extends AdvancedCache<string, CoherenceResult> {
  /** filePath -> keys derived from it (for invalidateFile). */
  private readonly fileIndex = new Map<string, Set<string>>();
  /** In-flight computations keyed by cache key (single-flight dedup). */
  private readonly inFlight = new Map<string, Promise<CoherenceResult>>();

  constructor(maxSize: number = 10_000, ttlMs: number = 300_000) {
    super({
      maxSize,
      ttlMs,
      persistent: true,
      persistPath: '.projectmind/coherence-cache.json',
    });
  }

  makeKey(code: string, filePath: string, deep: boolean): string {
    const key = `${stableHash(code)}-${filePath}-${deep ? 'deep' : 'fast'}`;
    let bucket = this.fileIndex.get(filePath);
    if (!bucket) {
      bucket = new Set();
      this.fileIndex.set(filePath, bucket);
    }
    bucket.add(key);
    return key;
  }

  /**
   * Cache-aside with single-flight: returns the cached verdict, or computes
   * it once even under concurrent callers, then caches it.
   */
  async getOrCompute(
    code: string,
    filePath: string,
    deep: boolean,
    compute: () => Promise<CoherenceResult>
  ): Promise<CoherenceResult> {
    const key = this.makeKey(code, filePath, deep);
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const flight = compute()
      .then((result) => {
        this.set(key, result);
        return result;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, flight);
    return flight;
  }

  /**
   * Drop every cached result for a file path (any code hash, fast or deep).
   * Call when a file's content changes on disk.
   */
  invalidateFile(filePath: string): number {
    const bucket = this.fileIndex.get(filePath);
    if (!bucket) return 0;
    let removed = 0;
    for (const key of bucket) {
      if (this.delete(key)) removed++;
    }
    this.fileIndex.delete(filePath);
    return removed;
  }

  /**
   * Remove expired entries eagerly (e.g. before persisting to disk).
   * Uses the base-class get(), which already treats an expired entry as a
   * miss and evicts it — so this doubles as the sweeper.
   */
  pruneExpired(): number {
    let pruned = 0;
    for (const key of [...this.getKeys()]) {
      if (this.get(key) === undefined) {
        // get() returned undefined: either already gone or just evicted
        // as expired by the base class. Count only real sweeps.
        pruned++;
      }
    }
    return pruned;
  }
}
