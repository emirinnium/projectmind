import type { CacheEntry, CacheOptions } from '../types.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Handles cache persistence to disk
 */
export class CachePersistence<K, V> {
  private readonly options: Required<CacheOptions<K, V>>;
  private persistTimer: ReturnType<typeof setInterval> | null = null;

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

    if (this.options.persistent) {
      this.startPersistTimer();
    }
  }

  loadFromDisk(map: Map<K, CacheEntry<V>>): void {
    if (!this.options.persistent) return;

    try {
      if (existsSync(this.options.persistPath)) {
        const data = readFileSync(this.options.persistPath, 'utf-8');
        const parsed = JSON.parse(data) as { key: string; value: V; createdAt: number; expiresAt: number }[];
        const now = Date.now();
        for (const item of parsed) {
          if (item.expiresAt > now) {
            map.set(item.key as unknown as K, {
              value: item.value,
              createdAt: item.createdAt,
              expiresAt: item.expiresAt,
              accessCount: 0,
              lastAccessed: now,
            });
          }
        }
      }
    } catch (e) {
      this.options.onError(e as Error);
    }
  }

  persistToDisk(map: Map<K, CacheEntry<V>>): void {
    if (!this.options.persistent) return;

    try {
      const dir = dirname(this.options.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const data = Array.from(map.entries()).map(([key, entry]) => ({
        key: String(key),
        value: entry.value,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
      }));

      writeFileSync(this.options.persistPath, JSON.stringify(data));
    } catch (e) {
      this.options.onError(e as Error);
    }
  }

  private startPersistTimer(): void {
    this.persistTimer = setInterval(() => {
      // The actual persist will be called by the main cache class
    }, 60_000); // Persist every minute
  }

  destroy(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
  }
}