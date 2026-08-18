import { AdvancedCache } from './advanced-cache.js';
import type { CoherenceResult } from '../coherence-engine.js';

export class CoherenceCache extends AdvancedCache<string, CoherenceResult> {
  constructor(maxSize: number = 10_000, ttlMs: number = 300_000) {
    super({
      maxSize,
      ttlMs,
      persistent: true,
      persistPath: '.projectmind/coherence-cache.json',
    });
  }

  makeKey(code: string, filePath: string, deep: boolean): string {
    const hash = this.hashCode(code);
    return `${hash}-${filePath}-${deep ? 'deep' : 'fast'}`;
  }

  private hashCode(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(16);
  }
}