import type { CacheEntry, CacheOptions } from '../types.js';

/**
 * Handles cache eviction policies (LRU, TTL)
 * 
 * Performance: O(1) amortized for get/set/has/delete.
 * Expired entry cleanup is done lazily and periodically to avoid O(n) scans on every operation.
 */
export class CacheEviction<K, V> {
  private map = new Map<K, CacheEntry<V>>();
  private readonly options: Required<CacheOptions<K, V>>;
  private operationCount = 0;
  private readonly purgeInterval: number;
  private lastPurgeTime = Date.now();
  private readonly purgeTimeIntervalMs: number;

  constructor(options: CacheOptions<K, V>) {
    this.options = {
      maxSize: options.maxSize,
      ttlMs: options.ttlMs,
      persistent: options.persistent ?? false,
      persistPath: options.persistPath ?? '.projectmind/cache.json',
      serialize: options.serialize ?? JSON.stringify,
      deserialize: options.deserialize ?? JSON.parse,
      onEvict: options.onEvict ?? (() => {}),
      onError: options.onError ?? (() => {}),
    };
    // Purge expired entries every N operations or every 5 minutes, whichever comes first
    this.purgeInterval = Math.min(options.maxSize, 100);
    this.purgeTimeIntervalMs = 5 * 60 * 1000; // 5 minutes
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }

    // LRU promotion - move to end of Map (most recently used)
    entry.lastAccessed = Date.now();
    entry.accessCount++;
    this.map.delete(key);
    this.map.set(key, entry);

    return entry.value;
  }

  set(key: K, value: V): void {
    const now = Date.now();
    this.operationCount++;

    // Periodic purge of expired entries (amortized O(1))
    if (this.shouldPurge(now)) {
      this.evictExpired();
    }

    // Evict LRU if at capacity (O(1) amortized - only evict one entry)
    if (this.map.size >= this.options.maxSize) {
      this.evictLRU();
    }

    const entry: CacheEntry<V> = {
      value,
      createdAt: now,
      expiresAt: now + this.options.ttlMs,
      accessCount: 0,
      lastAccessed: now,
    };

    this.map.set(key, entry);
  }

  has(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  getKeys(): K[] {
    return Array.from(this.map.keys());
  }

  getValues(): V[] {
    return Array.from(this.map.values()).map(e => e.value);
  }

  getEntries(): [K, V][] {
    return Array.from(this.map.entries()).map(([k, v]) => [k, v.value]);
  }

  /**
   * Check if we should run a purge of expired entries.
   * Uses both operation count and time-based thresholds.
   */
  private shouldPurge(now: number): boolean {
    return (
      this.operationCount >= this.purgeInterval ||
      now - this.lastPurgeTime >= this.purgeTimeIntervalMs
    );
  }

  private evictExpired(): void {
    const now = Date.now();
    this.lastPurgeTime = now;
    this.operationCount = 0;
    for (const [key, entry] of this.map.entries()) {
      if (now > entry.expiresAt) {
        this.options.onEvict(key, entry.value);
        this.map.delete(key);
      }
    }
  }

  private evictLRU(): void {
    // Map preserves insertion order, so first entry is oldest/least recently used
    const firstKey = this.map.keys().next().value;
    if (firstKey !== undefined) {
      const entry = this.map.get(firstKey);
      if (entry) {
        this.options.onEvict(firstKey, entry.value);
      }
      this.map.delete(firstKey);
    }
  }

  estimateMemoryUsage(): number {
    let size = 0;
    for (const [key, entry] of this.map.entries()) {
      try {
        size += JSON.stringify(key).length;
        size += this.options.serialize(entry.value).length;
      } catch {
        size += 100; // fallback estimate
      }
    }
    return size;
  }

  getMap(): Map<K, CacheEntry<V>> {
    return this.map;
  }

  /**
   * Get cache statistics for monitoring.
   */
  getStats(): { size: number; maxSize: number; purgeInterval: number; operationsSincePurge: number } {
    return {
      size: this.map.size,
      maxSize: this.options.maxSize,
      purgeInterval: this.purgeInterval,
      operationsSincePurge: this.operationCount,
    };
  }
}
