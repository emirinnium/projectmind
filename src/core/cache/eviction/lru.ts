import type { CacheEntry, CacheOptions } from '../types.js';

/**
 * Handles cache eviction policies (LRU, TTL)
 */
export class CacheEviction<K, V> {
  private map = new Map<K, CacheEntry<V>>();
  private readonly options: Required<CacheOptions<K, V>>;

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

    // LRU promotion
    entry.lastAccessed = Date.now();
    entry.accessCount++;
    this.map.delete(key);
    this.map.set(key, entry);

    return entry.value;
  }

  set(key: K, value: V): void {
    const now = Date.now();

    // Evict expired entries first
    this.evictExpired();

    // Evict LRU if at capacity
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

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.map.entries()) {
      if (now > entry.expiresAt) {
        this.options.onEvict(key, entry.value);
        this.map.delete(key);
      }
    }
  }

  private evictLRU(): void {
    let oldestKey: K | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.map.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      const entry = this.map.get(oldestKey)!;
      this.options.onEvict(oldestKey, entry.value);
      this.map.delete(oldestKey);
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
}