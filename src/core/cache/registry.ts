import type { CacheStats } from './types.js';
import { AdvancedCache } from './advanced-cache.js';

/**
 * Cache registry for managing multiple caches
 */
export class CacheRegistry {
  private caches = new Map<string, AdvancedCache<any, any>>();

  register<K, V>(name: string, cache: AdvancedCache<K, V>): void {
    this.caches.set(name, cache);
  }

  get<K, V>(name: string): AdvancedCache<K, V> | undefined {
    return this.caches.get(name) as AdvancedCache<K, V> | undefined;
  }

  getOrCreate<K, V>(name: string, factory: () => AdvancedCache<K, V>): AdvancedCache<K, V> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = factory();
      this.caches.set(name, cache);
    }
    return cache as AdvancedCache<K, V>;
  }

  getAllStats(): Record<string, CacheStats> {
    const stats: Record<string, CacheStats> = {};
    for (const [name, cache] of this.caches.entries()) {
      stats[name] = cache.getStats();
    }
    return stats;
  }

  clearAll(): void {
    for (const cache of this.caches.values()) {
      cache.clear();
    }
  }

  destroyAll(): void {
    for (const cache of this.caches.values()) {
      cache.destroy();
    }
    this.caches.clear();
  }
}

export const globalCacheRegistry = new CacheRegistry();