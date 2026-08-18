import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../../storage/database.js';
import { SCHEMA_SQL } from '../../storage/schema.js';
import { CoherenceCache } from '../cache/index.js';
import { FastCoherenceAnalyzer } from './analysis/fast.js';
import { DeepCoherenceAnalyzer } from './analysis/deep.js';
import type { LLMProvider, CoherenceResult, CoherenceCheckOptions } from './analysis/fast.js';

export type { LLMProvider, CoherenceResult, CoherenceCheckOptions } from './analysis/fast.js';

export class CoherenceEngine {
  private db: DatabaseSync;
  private cache: CoherenceCache;
  private fastAnalyzer: FastCoherenceAnalyzer;
  private deepAnalyzer: DeepCoherenceAnalyzer;

  constructor(db?: DatabaseSync, maxCacheSize: number = 10_000, ttlMs: number = 300_000) {
    this.db = db ?? getDatabase();
    this.db.exec(SCHEMA_SQL);
    this.cache = new CoherenceCache(maxCacheSize, ttlMs);
    this.fastAnalyzer = new FastCoherenceAnalyzer(this.db, this.cache);
    this.deepAnalyzer = new DeepCoherenceAnalyzer(this.db, this.cache);
  }

  setLLMProvider(provider: LLMProvider): void {
    this.deepAnalyzer.setLLMProvider(provider);
  }

  hasLLMProvider(): boolean {
    return this.deepAnalyzer['llmProvider']?.isAvailable() ?? false;
  }

  async checkCoherence(options: CoherenceCheckOptions): Promise<CoherenceResult> {
    const cacheKey = this.cache.makeKey(options.code, options.filePath, options.deepAnalysis ?? false);

    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    if (!options.fastOnly && this.deepAnalyzer['llmProvider']?.isAvailable()) {
      return this.deepAnalyzer.analyze(options, cacheKey);
    }

    return this.fastAnalyzer.analyze(options, cacheKey);
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.getKeys().length;
  }

  getCacheStats() {
    return this.cache.getStats();
  }
}