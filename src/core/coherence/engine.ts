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
  private offline: boolean = false;

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

  /**
   * Set offline mode. When true, only fast-tier (local) analysis is used.
   * No code is sent to cloud LLM APIs.
   */
  setOffline(offline: boolean): void {
    this.offline = offline;
    this.deepAnalyzer.setAllowCloudLLM(!offline);
  }

  isOffline(): boolean {
    return this.offline;
  }

  /**
   * Drop every cached coherence verdict for a file path (any code hash,
   * fast and deep). Call when a file changes on disk so the next check
   * analyzes fresh content instead of serving a stale verdict.
   */
  invalidateFileCache(filePath: string): number {
    return this.cache.invalidateFile(filePath);
  }

  async checkCoherence(options: CoherenceCheckOptions): Promise<CoherenceResult> {
    const cacheKey = this.cache.makeKey(
      options.code,
      options.filePath,
      options.deepAnalysis ?? false,
    );

    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Force fast-only when offline or when deep analysis not requested
    if (this.offline || options.fastOnly || !this.deepAnalyzer['llmProvider']?.isAvailable()) {
      return this.fastAnalyzer.analyze(options, cacheKey);
    }

    return this.deepAnalyzer.analyze(options, cacheKey);
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
