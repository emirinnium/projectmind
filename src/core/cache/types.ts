export interface CacheEntry<V> {
  value: V;
  createdAt: number;
  expiresAt: number;
  accessCount: number;
  lastAccessed: number;
}

export interface CacheStats {
  size: number;
  maxSize: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  memoryUsage: number;
  oldestEntry: number;
  newestEntry: number;
}

export interface CacheOptions<K, V> {
  maxSize: number;
  ttlMs: number;
  persistent?: boolean;
  persistPath?: string;
  serialize?: (value: V) => string;
  deserialize?: (data: string) => V;
  onEvict?: (key: K, value: V) => void;
  onError?: (error: Error) => void;
}