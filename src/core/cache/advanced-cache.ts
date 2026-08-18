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
 */
export class AdvancedCache<K, V> {
  private eviction: CacheEviction<K, V>;
  private persistence: CachePersistence<K, V>;
  private hitCount = 0;
  private missCount = 0;

  constructor(options: CacheOptions<K, V>) {
    this.eviction = new CacheEviction(options);
    this.persistence = new CachePersistence(options);
    
    if (options.persistent) {
      this.persistence.loadFromDisk(this.eviction.getMap());
    }
  }

  get(key: K): V | undefined {
    const entry = this.eviction.getMap().get(key);
    if (!entry) {
      this.missCount++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.eviction.delete(key);
      this.missCount++;
      return undefined;
    }

    // LRU promotion
    entry.lastAccessed = Date.now();
    entry.accessCount++;
    this.eviction.getMap().delete(key);
    this.eviction.getMap().set(key, entry);

    this.hitCount++;
    return entry.value;
  }

  set(key: K, value: V): void {
    this.eviction.set(key, value);
  }

  has(key: K): boolean {
    return this.eviction.has(key);
  }

  delete(key: K): boolean {
    return this.eviction.delete(key);
  }

  clear(): void {
    this.eviction.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }

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

  getKeys(): K[] {
    return this.eviction.getKeys();
  }

  getValues(): V[] {
    return this.eviction.getValues();
  }

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

  persistNow(): void {
    this.persistence.persistToDisk(this.eviction.getMap());
  }

  destroy(): void {
    this.persistence.destroy();
    if (this.eviction['options'].persistent) {
      this.persistence.persistToDisk(this.eviction.getMap());
    }
    this.clear();
  }
}