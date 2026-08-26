import { generateEmbedding } from '../../parser/embeddings-v2.js';
import { cosineSimilarity } from '../../parser/legacy-embeddings.js';
import { EmbeddingCache } from '../cache/embedding-cache.js';

/**
 * RAG-style semantic search over team memories (P4-1 v1).
 *
 * Pipeline: embed the query once → embed stored memory values through a
 * shared single-flight EmbeddingCache → cosine-rank → return top hits with
 * scores. Works fully OFFLINE via the deterministic simple provider;
 * automatically upgrades when a real embedding provider (UniXcoder /
 * CodeBERT / OpenAI) is initialized.
 *
 * Honest scope: linear scan over memories (capped), not an ANN index. At
 * team-memory scale (< a few thousand entries) this is milliseconds.
 */

export interface SemanticMemoryHit {
  id: number;
  agentName: string;
  scope: string;
  key: string;
  /** Truncated value preview (full text stays in the DB). */
  preview: string;
  score: number;
}

export interface MemoryRowLike {
  id: number;
  agentName: string;
  scope: string;
  key: string;
  value: string;
}

export interface SemanticMemoryOptions {
  query: string;
  scope?: string;
  agentName?: string;
  limit?: number;
  /** Cosine floor — below this, matches are dropped (default 0.05). */
  threshold?: number;
  /** Safety cap on scanned rows (default 500). */
  maxRows?: number;
  /** Embedding dimension for the simple fallback provider. */
  dim?: number;
}

/** Process-wide shared cache so repeated searches don't re-embed values. */
let sharedCache: EmbeddingCache | null = null;
function getSharedCache(): EmbeddingCache {
  if (!sharedCache) sharedCache = new EmbeddingCache();
  return sharedCache;
}

export async function searchTeamMemoriesSemantic(
  rowsProvider: () => MemoryRowLike[],
  options: SemanticMemoryOptions
): Promise<{ query: string; scanned: number; returned: number; hits: SemanticMemoryHit[]; note: string }> {
  const limit = Math.max(1, Math.min(50, options.limit ?? 5));
  const threshold = options.threshold ?? 0.05;
  const maxRows = Math.max(1, Math.min(5000, options.maxRows ?? 500));
  const dim = options.dim ?? 256;

  let rows = rowsProvider().slice(0, maxRows);
  if (options.scope) rows = rows.filter((r) => r.scope === options.scope);
  if (options.agentName) rows = rows.filter((r) => r.agentName === options.agentName);

  if (rows.length === 0) {
    return { query: options.query, scanned: 0, returned: 0, hits: [], note: 'no team memories matched the scope/agent filters' };
  }

  const cache = getSharedCache();
  const queryVec = await cache.getOrCompute(options.query, dim, () => generateEmbedding(options.query, dim));

  // Embed in small concurrent batches to keep latency sane without
  // hammering external providers.
  const vectors: number[][] = [];
  const BATCH = 32;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const vecs = await Promise.all(
      chunk.map((r) => cache.getOrCompute(`${r.key}\n${r.value}`, dim, () => generateEmbedding(`${r.key}\n${r.value}`, dim)))
    );
    vectors.push(...vecs);
  }

  const scored: SemanticMemoryHit[] = [];
  for (let i = 0; i < rows.length; i++) {
    const score = Number(cosineSimilarity(queryVec, vectors[i]).toFixed(4));
    if (score >= threshold) {
      scored.push({
        id: rows[i].id,
        agentName: rows[i].agentName,
        scope: rows[i].scope,
        key: rows[i].key,
        preview: rows[i].value.length > 160 ? `${rows[i].value.slice(0, 157)}…` : rows[i].value,
        score,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  return {
    query: options.query,
    scanned: rows.length,
    returned: Math.min(limit, scored.length),
    hits: scored.slice(0, limit),
    note: 'cosine-ranked over cached embeddings; pass higher limit or lower threshold for broader recall',
  };
}
