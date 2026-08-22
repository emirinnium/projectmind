import { AdvancedCache } from './advanced-cache.js';
import type { CoherenceResult } from '../coherence/engine.js';
import { stableHash } from '../../utils/hash.js';

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
    return `${stableHash(code)}-${filePath}-${deep ? 'deep' : 'fast'}`;
  }
}