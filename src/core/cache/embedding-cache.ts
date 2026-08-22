import { AdvancedCache } from './advanced-cache.js';
import { stableHash } from '../../utils/hash.js';

export class EmbeddingCache extends AdvancedCache<string, number[]> {
  constructor(maxSize: number = 50_000, ttlMs: number = 86_400_000) { // 24 hours
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
}