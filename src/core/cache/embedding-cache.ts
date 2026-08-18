import { AdvancedCache } from './advanced-cache.js';

export class EmbeddingCache extends AdvancedCache<string, number[]> {
  constructor(maxSize: number = 50_000, ttlMs: number = 86_400_000) { // 24 hours
    super({
      maxSize,
      ttlMs,
      persistent: true,
      persistPath: '.projectmind/embedding-cache.json',
    });
  }

  makeKey(text: string, dim: number = 128): string {
    return `${dim}:${this.hashCode(text)}`;
  }

  private hashCode(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(16);
  }
}