import { FileInfo } from '../../../storage/knowledge-graph.js';
import { cosineSimilarity } from '../../../parser/embeddings.js';
import { AdvancedCache } from '../../cache/advanced-cache.js';
import { EmbeddingCache, globalCacheRegistry } from '../../cache/index.js';
import type { CacheStats } from '../../cache/types.js';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../../../storage/database.js';
import { getVecIndex, type VecIndex } from '../../embeddings/vector-index.js';
import { logger } from '../../../utils/logger.js';
import { isTestPath } from '../../../utils/test-detection.js';

// Canonical debt type declarations live in persistence.ts — re-exported here
// to keep this module's public surface unchanged (no duplicate declarations).
export type { DebtType, Severity, DebtItem, DebtReport } from './persistence.js';

/**
 * Handles detection of code redundancy through embedding similarity
 * Structurally matches the RedundancyDetector interface for loose coupling.
 */
export class RedundancyDetector {
  private embeddingCache: AdvancedCache<string, number[]>;
  private db: DatabaseSync;
  private vecIndex: VecIndex;

  constructor(db?: DatabaseSync) {
    this.embeddingCache = globalCacheRegistry.getOrCreate(
      'embeddings',
      () => new EmbeddingCache(),
    ) as AdvancedCache<string, number[]>;
    this.db = db || getDatabase();
    this.vecIndex = getVecIndex(this.db);
  }
  getCacheStats(): CacheStats | { error: string } {
    return this.embeddingCache?.getStats?.() ?? { error: 'Cache not initialized' };
  }

  /**
   * Batch-fetch embeddings for all file IDs in a single query.
   * Replaces N+1 individual SELECT statements.
   * Uses cache to avoid recomputing embeddings.
   */
  getFileEmbeddings(fileIds: number[]): Map<number, number[]> {
    const result = new Map<number, number[]>();
    if (fileIds.length === 0) return result;

    // Defensive null-check for embeddingCache
    if (!this.embeddingCache) {
      logger.warn('embeddingCache is not initialized, returning empty results');
      return result;
    }

    // Check cache first
    const cachedEmbeddings = new Map<number, number[]>();
    const uncachedIds: number[] = [];

    for (const id of fileIds) {
      const cacheKey = `file:${id}`;
      const cached = this.embeddingCache.get(cacheKey);
      if (cached) {
        cachedEmbeddings.set(id, cached);
      } else {
        uncachedIds.push(id);
      }
    }

    // Fetch uncached embeddings from DB as Float32 BLOB
    if (uncachedIds.length > 0) {
      const placeholders = uncachedIds.map(() => '?').join(',');
      const stmt = this.db.prepare(`SELECT id, embedding FROM files WHERE id IN (${placeholders})`);
      const rows = stmt.all(...uncachedIds) as { id: number; embedding: Buffer | null }[];

      for (const row of rows) {
        if (!row.embedding) continue;
        try {
          // Convert BLOB to Float32Array
          const embedding = new Float32Array(row.embedding.buffer);
          result.set(row.id, Array.from(embedding));
          this.embeddingCache.set(`file:${row.id}`, Array.from(embedding));
        } catch {
          // skip invalid embeddings
        }
      }
    }

    // Merge cached and fetched
    for (const [id, emb] of cachedEmbeddings) {
      result.set(id, emb);
    }

    return result;
  }

  /**
   * Find similar files using pre-fetched embeddings (no per-file DB queries).
   * Threshold set to 0.95 to reduce false positives from boilerplate similarity.
   *
   * Uses the shared VecIndex when available (sub-millisecond ANN), falling
   * back to in-memory cosine similarity when sqlite-vec is unavailable.
   */
  async findSimilarFiles(
    target: FileInfo,
    targetEmbedding: number[],
    allFiles: FileInfo[],
    embeddings: Map<number, number[]>,
  ): Promise<FileInfo[]> {
    const THRESHOLD = 0.95;
    const MIN_FILE_BYTES = 256;
    if (isTestPath(target.relativePath)) return [];
    if (target.sizeBytes < MIN_FILE_BYTES) return [];

    // Debt redundancy is a production-code signal. Test fixtures frequently
    // repeat setup/assertion scaffolding by design, so comparing them with
    // source files produces noisy low-severity findings. Also exclude the
    // target itself because ANN indexes can return an exact self-match.
    const candidateFiles = allFiles.filter(
      (file) =>
        file.id !== target.id && file.sizeBytes >= MIN_FILE_BYTES && !isTestPath(file.relativePath),
    );
    const candidateIds = new Set(candidateFiles.map((file) => file.id));

    // Fast path: sqlite-vec ANN via the shared VecIndex.
    if (this.vecIndex.isAvailable()) {
      // Ensure the index is populated for these embeddings.
      for (const [id, emb] of embeddings) {
        this.vecIndex.upsert(id, emb);
      }

      const rawMatches = this.vecIndex.findSimilar(targetEmbedding, 20);
      const matchIds = rawMatches
        .filter((m) => candidateIds.has(m.id) && 1 - m.distance >= THRESHOLD)
        .map((m) => m.id);

      if (matchIds.length > 0) {
        const idSet = new Set(matchIds);
        return candidateFiles.filter((f) => idSet.has(f.id));
      }
      return [];
    }

    // Fallback: in-memory cosine similarity (original behaviour).
    const targetFileId = target.id;
    const results: FileInfo[] = [];
    for (const [id, emb] of embeddings) {
      if (id === targetFileId || !candidateIds.has(id)) continue;
      const score = cosineSimilarity(targetEmbedding, emb);
      if (score >= THRESHOLD) {
        const file = candidateFiles.find((f) => f.id === id);
        if (file) results.push(file);
      }
    }
    return results;
  }
}
