import type { CacheStats, CacheOptions } from './types.js';
import { CacheEviction } from './eviction/lru.js';
import { CachePersistence } from './eviction/persistence.js';

/**
 * Advanced Cache System for ProjectMind
 *
 * Features:
 * - LRU eviction with TTL
 * - Persistent cache to disk (optional)
 * - Cache statistics and metrics
 * - Multiple cache backends (memory, disk, hybrid)
 * - Cache warming and preloading
 *
 * Type Parameters:
 * - K: Key type
 * - V: Value type
 *
 * The cache returns `undefined` when:
 * - The key is not found in the underlying storage
 * - The entry has expired (TTL exceeded)
 * - The cache has been cleared
 */
export class AdvancedCache<K, V> {
  private eviction: CacheEviction<K, V>;
  private persistence: CachePersistence<K, V>;
  private hitCount = 0;
  private missCount = 0;

  /**
   * Constructs an AdvancedCache instance.
   *
   * @param options Configuration options for the cache
   * - maxSize: Maximum number of entries (LRU eviction threshold)
   * - ttlMs: Time-to-live in milliseconds for each entry
   * - persistent: If true, loads/saves cache to disk between sessions
   * - persistPath: Optional custom path for persistent storage
   * - onEvict: Callback invoked when an entry is evicted (LRU)
   * - onError: Callback invoked when an unexpected error occurs
   */
  constructor(options: CacheOptions<K, V>) {
    this.eviction = new CacheEviction(options);
    this.persistence = new CachePersistence(options);

    if (options.persistent) {
      this.persistence.loadFromDisk(this.eviction.getMap());
    }
  }

  /**
   * Retrieves the value associated with the given key.
   *
   * @param key The key whose associated value is to be retrieved.
   * @returns The value associated with the key, or `undefined` if the key
   *   is not found or the entry has expired (and been removed).
   *
   * @example
 * ```typescript
 * const value = cache.get('some-key');
 * if (value === undefined) {
 *   // key not found or expired
 * }
 * ```
   */
  get(key: K): V | undefined {
    const entry = this.eviction.getMap().get(key);
    if (!entry) {
      this.missCount++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.eviction.delete(key);
      this.missCount++;
      return undefined; // expired entry removed
    }

    // LRU promotion: move accessed entry to front
    entry.lastAccessed = Date.now();
    entry.accessCount++;
    this.eviction.getMap().delete(key);
    this.eviction.getMap().set(key, entry);

    this.hitCount++;
    return entry.value;
  }

  /**
   * Associates a key with a value in the cache.
   *
   * If the key already exists, the value is updated and the entry is
   * moved to the front of the LRU order. Does not update the expiration
   * time unless a new TTL is specified in the options.
   *
   * @param key The key to associate with the value.
   * @param value The value to store in the cache.
   * @returns `void`
   */
  set(key: K, value: V): void {
    this.eviction.set(key, value);
  }

  /**
   * Checks whether a key exists in the cache (and is not expired).
   *
   * @param key The key to check for existence.
   * @returns `true` if the key exists and has not expired; `false` otherwise.
   */
  has(key: K): boolean {
    return this.eviction.has(key);
  }

  /**
   * Deletes an entry from the cache.
   *
   * @param key The key to remove from the cache.
   * @returns `true` if an entry was successfully removed, `false` if the
   *   key did not exist.
   */
  delete(key: K): boolean {
    return this.eviction.delete(key);
  }

  /**
   * Clears all entries from the cache and resets the hit/miss counters.
   *
   * After calling this method, the cache is empty and `get()` will always
   * return `undefined` until new entries are added via `set()` or `warm()`.
   */
  clear(): void {
    this.eviction.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }

  /**
   * Returns statistics about the cache state, including hit/miss rates,
   * memory usage, and entry age information.
   *
   * @returns A `CacheStats` object containing current cache metrics.
   *
   * @description
   * The returned `CacheStats` object includes:
   * - `hitRate`: The ratio of cache hits to total lookups (0..1).
   * - `size` / `maxSize`: Current and maximum number of entries.
   * - `hitCount` / `missCount`: Absolute hit and miss counters.
   * - `memoryUsage`: Estimated memory usage in bytes.
   * - `oldestEntry` / `newestEntry`: Timestamps of the oldest and newest entries.
   */
  getStats(): CacheStats {
    const entries = Array.from(this.eviction.getMap().values());
    const now = Date.now();

    return {
      size: this.eviction.getMap().size,
      maxSize: this.eviction['options'].maxSize,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: this.hitCount + this.missCount > 0
        ? this.hitCount / (this.hitCount + this.missCount)
        : 0,
      memoryUsage: this.eviction.estimateMemoryUsage(),
      oldestEntry: entries.length > 0
        ? Math.min(...entries.map(e => e.createdAt))
        : now,
      newestEntry: entries.length > 0
        ? Math.max(...entries.map(e => e.createdAt))
        : now,
    };
  }

  /**
   * Returns all keys currently stored in the cache.
   *
   * @returns An array of keys. May be empty if the cache has no entries.
   */
  getKeys(): K[] {
    return this.eviction.getKeys();
  }

  /**
   * Returns all values currently stored in the cache.
   *
   * @returns An array of values corresponding to the keys. May be empty if
   *   the cache has no entries. The order of values corresponds to the order
   *   of keys returned by `getKeys()`.
   */
  getValues(): V[] {
    return this.eviction.getValues();
  }

  /**
   * Returns all key-value entries currently stored in the cache.
   *
   * @returns An array of `[key, value]` tuples. May be empty if the cache
   *   has no entries. The order corresponds to the order of keys from
   *   `getKeys()`.
   */
  getEntries(): [K, V][] {
    return this.eviction.getEntries();
  }

  // Preload multiple entries at once
  preload(entries: [K, V][]): void {
    for (const [key, value] of entries) {
      this.set(key, value);
    }
  }

  // Warm cache with a function that generates values
/**
   * Asynchronously preloads multiple cache entries using a generator function.
   *
   * For each key in the provided list, if the key is not already present in
   * the cache, the generator function is called to produce the value, which
   * is then stored in the cache. If the generator function throws, the
   * promise returned by `warm` will reject with that error.
   *
   * @param keys An array of keys to warm.
   * @param generator An async function that produces a value for each key.
   *   May throw if the value cannot be generated/computed.
   * @returns A promise that resolves when all entries have been warmed.
   * @throws {Error} If the generator function throws for any key, the promise
   *   will reject with the generator's error.
   *
   * @example
   * ```typescript
   * await cache.warm(['user:1', 'user:2'], async (key) => {
   *   const dbUser = await db.findUser(key);
   *   return dbUser ?? null;
   * });
   * ```
   */
  async warm<K2 extends K>(keys: K2[], generator: (key: K2) => Promise<V>): Promise<void> {
    await Promise.all(
      keys.map(async (key) => {
        if (!this.has(key)) {
          const value = await generator(key);
          this.set(key, value);
        }
      })
    );
  }

  /**
   * Persists the current cache state to disk immediately.
   *
   * If the cache was constructed with `persistent: true`, this writes the
   * current in-memory entries to the persistent storage path. This is useful
   * after a batch of operations to ensure data is flushed before releasing
   * memory or shutting down.
   */
  persistNow(): void {
    this.persistence.persistToDisk(this.eviction.getMap());
  }

  /**
   * Destroys the cache, releasing all resources.
   *
   * - Stops the persistence backend (if active)
   * - If `persistent: true`, writes the current state to disk one final time
   * - Clears all in-memory entries and resets hit/miss counters
   *
   * After calling this method, the cache is completely empty and must be
   * re-constructed if used again.
   */
  destroy(): void {
    this.persistence.destroy();
    if (this.eviction['options'].persistent) {
      this.persistence.persistToDisk(this.eviction.getMap());
    }
    this.clear();
  }
}