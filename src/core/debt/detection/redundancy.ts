import { FileInfo } from '../../../storage/knowledge-graph.js';
import { cosineSimilarity } from '../../../parser/embeddings.js';
import { AdvancedCache } from '../../cache/advanced-cache.js';
import { EmbeddingCache, globalCacheRegistry } from '../../cache/index.js';
import type { CacheStats } from '../../cache/types.js';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { getDatabase } from '../../../storage/database.js';
import { getVecIndex } from '../../embeddings/vector-index.js';
import { decodeEmbedding } from '../../embeddings/embedding-codec.js';
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

  constructor(db?: DatabaseSync) {
    this.embeddingCache = globalCacheRegistry.getOrCreate(
      'embeddings',
      () => new EmbeddingCache(),
    ) as AdvancedCache<string, number[]>;
    this.db = db || getDatabase();
  }
  getCacheStats(): CacheStats | { error: string } {
    return this.embeddingCache?.getStats?.() ?? { error: 'Cache not initialized' };
  }

  private isUsableEmbedding(embedding: number[], expectedDimension?: number): boolean {
    return (
      embedding.length > 0 &&
      (expectedDimension === undefined || embedding.length === expectedDimension) &&
      embedding.every(Number.isFinite) &&
      embedding.some((value) => value !== 0)
    );
  }

  /**
   * Batch-fetch embeddings for all file IDs in a single query.
   *
   * The database is the source of truth here. A previous implementation used
   * a persistent `file:<id>` cache, which had no content hash and could feed a
   * stale vector back into debt detection after a separate scan process
   * updated the database. Reading the current row also makes this method safe
   * across CLI/MCP process boundaries.
   */
  getFileEmbeddings(fileIds: number[]): Map<number, number[]> {
    const result = new Map<number, number[]>();
    if (fileIds.length === 0) return result;

    const placeholders = fileIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT id, embedding FROM files WHERE id IN (${placeholders})`)
      .all(...fileIds) as Array<{ id: number; embedding: SQLOutputValue | null }>;

    for (const row of rows) {
      const embedding = decodeEmbedding(row.embedding);
      // Zero/invalid vectors have no direction and must never participate in
      // similarity detection. They were the main source of false duplicate
      // findings for files containing only classes, types, or exports.
      if (this.isUsableEmbedding(embedding)) {
        result.set(row.id, embedding);
      }
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
    if (!this.isUsableEmbedding(targetEmbedding)) return [];

    // Debt redundancy is a production-code signal. Test fixtures frequently
    // repeat setup/assertion scaffolding by design, so comparing them with
    // source files produces noisy low-severity findings. Also exclude the
    // target itself because ANN indexes can return an exact self-match.
    const candidateFiles = allFiles.filter(
      (file) =>
        file.id !== target.id &&
        file.sizeBytes >= MIN_FILE_BYTES &&
        !isTestPath(file.relativePath) &&
        this.isUsableEmbedding(embeddings.get(file.id) ?? [], targetEmbedding.length),
    );
    const candidateIds = new Set(candidateFiles.map((file) => file.id));
    const vecIndex = getVecIndex(this.db, targetEmbedding.length);

    // Fast path: sqlite-vec ANN via the shared VecIndex.
    if (vecIndex.isAvailable() && targetEmbedding.length === vecIndex.dimension()) {
      // Ensure the index is populated for these embeddings.
      for (const [id, emb] of embeddings) {
        if (this.isUsableEmbedding(emb, vecIndex.dimension())) {
          vecIndex.upsert(id, emb);
        }
      }

      const rawMatches = vecIndex.findSimilar(targetEmbedding, 20);
      // sqlite-vec is an accelerator only. Re-score candidates with the
      // canonical cosine implementation so a stale/partially rebuilt index or
      // a metric change can never create a debt item on its own.
      const matchIds = rawMatches
        .filter((m) => candidateIds.has(m.id))
        .map((m) => ({ id: m.id, score: cosineSimilarity(targetEmbedding, embeddings.get(m.id)!) }))
        .filter((m) => m.score >= THRESHOLD)
        .sort((a, b) => b.score - a.score)
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
