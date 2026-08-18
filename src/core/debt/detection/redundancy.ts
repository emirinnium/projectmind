import { getStatement } from '../../../storage/database.js';
import { FileInfo } from '../../../storage/knowledge-graph.js';
import { cosineSimilarity } from '../../../parser/embeddings.js';
import { AdvancedCache } from '../../cache/advanced-cache.js';
import { EmbeddingCache, globalCacheRegistry } from '../../cache/index.js';

export type DebtType = 'pattern_drift' | 'architectural_drift' | 'redundancy' | 'agent_conflict';
export type Severity = 'high' | 'medium' | 'low';

export interface DebtItem {
  id: number;
  type: DebtType;
  description: string;
  severity: Severity;
  suggestion: string;
  reasoningTrace: string[];
  detectedAt: string;
  resolved: boolean;
  filePath: string | null;
}

export interface DebtReport {
  totalItems: number;
  bySeverity: Record<Severity, number>;
  byType: Record<DebtType, number>;
  coherenceGenomeScore: number;
  items: DebtItem[];
}

/**
 * Handles detection of code redundancy through embedding similarity
 */
export class RedundancyDetector {
  private embeddingCache: AdvancedCache<string, number[]>;

  constructor() {
    this.embeddingCache = globalCacheRegistry.getOrCreate('embeddings', () => new EmbeddingCache()) as AdvancedCache<string, number[]>;
  }

  /**
   * Batch-fetch embeddings for all file IDs in a single query.
   * Replaces N+1 individual SELECT statements.
   * Uses cache to avoid recomputing embeddings.
   */
  getFileEmbeddings(fileIds: number[]): Map<number, number[]> {
    const result = new Map<number, number[]>();
    if (fileIds.length === 0) return result;

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

    // Fetch uncached embeddings from DB
    if (uncachedIds.length > 0) {
      const placeholders = uncachedIds.map(() => '?').join(',');
      const rows = getStatement(`SELECT id, embedding FROM files WHERE id IN (${placeholders})`)
        .all(...uncachedIds) as { id: number; embedding: string | null }[];

      for (const row of rows) {
        if (!row.embedding) continue;
        try {
          const embedding = JSON.parse(row.embedding) as number[];
          result.set(row.id, embedding);
          this.embeddingCache.set(`file:${row.id}`, embedding);
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
   */
  findSimilarFiles(
    target: FileInfo,
    targetEmbedding: number[],
    allFiles: FileInfo[],
    embeddings: Map<number, number[]>
  ): FileInfo[] {
    const candidates: { id: number; embedding: number[] }[] = [];
    for (const f of allFiles) {
      if (f.id === target.id) continue;
      const emb = embeddings.get(f.id);
      if (emb) candidates.push({ id: f.id, embedding: emb });
    }

    return candidates
      .map((c) => ({ id: c.id, score: cosineSimilarity(targetEmbedding, c.embedding) }))
      .filter((r) => r.score > 0.95)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((r) => allFiles.find((f) => f.id === r.id)!)
      .filter(Boolean);
  }
}