import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { VecIndex } from '../embeddings/vector-index.js';
import type {
  HybridScore,
  IntentQuery,
  IntentType,
  SearchResult,
  SemanticEvidence,
} from './types.js';
import type { KGGraphLike } from './graph-adapter.js';
import { safeScore } from './scoring.js';
import { logger } from '../../utils/logger.js';

export interface SemanticSearchCandidate {
  path: string;
  score: number;
  source: 'embedding' | 'lexical';
  semanticEvidence: SemanticEvidence;
}

export interface IntentSearchContext {
  embeddingDimension: number;
  vecIndex?: VecIndex;
  db?: DatabaseSync;
  generateEmbedding(text: string, dimension: number): Promise<number[]>;
  resolveQueryText(query: IntentQuery): string;
  classifyIntent(query: IntentQuery): IntentType;
  computeSemanticScore(
    queryText: string,
    filePath: string,
  ): Promise<{
    score: number;
    source: 'embedding' | 'lexical';
    semanticEvidence: SemanticEvidence;
  }>;
  computeHybridScore(
    query: IntentQuery,
    filePath: string,
    kgGraph: KGGraphLike,
    semanticScore?: number,
    semanticSource?: 'embedding' | 'lexical',
  ): HybridScore;
  deriveSemanticFromSimilar(
    similarResults: Array<{ path: string; score?: number }>,
  ): SemanticSearchCandidate[];
  resolveFilePath(filePath: string): string | undefined;
  getMarkers(intent: IntentType, content: string): number;
}

const RANK_DECAY_FACTOR = 0.15;

/** Execute the hybrid semantic, vector, lexical, and structural search flow. */
export async function executeIntentSearch(
  context: IntentSearchContext,
  query: IntentQuery,
  kgGraph: KGGraphLike | undefined,
  limit: number,
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const queryText = context.resolveQueryText(query);
  const intent = context.classifyIntent(query);
  let semanticFiles: SemanticSearchCandidate[] = [];

  try {
    const queryEmbedding = await context.generateEmbedding(queryText, context.embeddingDimension);
    if (kgGraph && typeof kgGraph.findSimilarFiles === 'function') {
      semanticFiles = context.deriveSemanticFromSimilar(
        kgGraph.findSimilarFiles(queryEmbedding, 0.5, limit),
      );
    }
  } catch (error) {
    logger.warn(`Semantic baseline search failed: ${formatError(error)}`);
  }

  if (semanticFiles.length === 0 && context.vecIndex?.isAvailable()) {
    try {
      const queryEmbedding = await context.generateEmbedding(queryText, context.embeddingDimension);
      const similar = context.vecIndex.findSimilar(queryEmbedding, limit);
      for (let i = 0; i < similar.length; i++) {
        const match = similar[i];
        let path = '';
        if (context.db) {
          const row = context.db
            .prepare('SELECT path FROM files WHERE id = ?')
            .get(Number(match.id)) as { path?: string } | undefined;
          if (row?.path) path = row.path;
        }
        if (!path) continue;
        const measured = safeScore(1 - Number(match.distance));
        semanticFiles.push({
          path,
          score: measured ?? Math.max(0, 1 - i * RANK_DECAY_FACTOR),
          source: 'embedding',
          semanticEvidence: measured === undefined ? 'rank-derived' : 'measured',
        });
      }
    } catch (error) {
      logger.warn(`VecIndex fallback search failed: ${formatError(error)}`);
    }
  }

  if (semanticFiles.length === 0 && query.filePath) {
    try {
      const lexical = await context.computeSemanticScore(queryText, query.filePath);
      semanticFiles.push({
        path: query.filePath,
        score: lexical.score,
        source: lexical.source,
        semanticEvidence: lexical.semanticEvidence,
      });
    } catch (error) {
      logger.warn(`Lexical fallback search failed: ${formatError(error)}`, {
        filePath: query.filePath,
      });
    }
  }

  const seen = new Set<string>();
  for (const candidate of semanticFiles) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    const score = context.computeHybridScore(
      query,
      candidate.path,
      kgGraph ?? { getFileByPath: () => null },
      candidate.score,
      candidate.source,
    );
    const snippet = readSnippet(context, candidate.path, intent);
    results.push({
      filePath: candidate.path,
      score,
      rank: 0,
      snippet: snippet || candidate.path,
      source: candidate.source,
      semanticEvidence: candidate.semanticEvidence,
    });
  }

  addStructuralNeighbors(context, results, seen, query, kgGraph);
  results.sort((a, b) => b.score.total - a.score.total);
  results.forEach((result, index) => {
    result.rank = index + 1;
  });
  return results.slice(0, limit);
}

function addStructuralNeighbors(
  context: IntentSearchContext,
  results: SearchResult[],
  seen: Set<string>,
  query: IntentQuery,
  kgGraph: KGGraphLike | undefined,
): void {
  if (!kgGraph || !query.filePath) return;
  try {
    const info = kgGraph.getFileByPath(query.filePath);
    if (!info || typeof info.id !== 'number') return;
    const imports = kgGraph.getImports ? kgGraph.getImports(info.id) : [];
    const dependents = kgGraph.getDependents ? kgGraph.getDependents(info.id) : [];
    const seedPaths = new Set<string>();
    for (const item of imports) if (item.source) seedPaths.add(item.source);
    for (const item of dependents) if (item.source) seedPaths.add(item.source);

    for (const seed of seedPaths) {
      if (seen.has(seed)) continue;
      seen.add(seed);
      const score = context.computeHybridScore(query, seed, kgGraph, 0.4, 'embedding');
      results.push({
        filePath: seed,
        score,
        rank: 0,
        snippet: readSnippet(context, seed, undefined) || seed,
        source: 'embedding',
        semanticEvidence: 'structural-heuristic',
      });
    }
  } catch (error) {
    logger.warn(`Structural neighbor expansion failed: ${formatError(error)}`, {
      filePath: query.filePath,
    });
  }
}

function readSnippet(context: IntentSearchContext, filePath: string, intent?: IntentType): string {
  try {
    const resolved = context.resolveFilePath(filePath);
    if (!resolved) return '';
    const content = readFileSync(resolved, 'utf-8');
    const lines = content.split(/\r?\n/);
    const markerIndex =
      intent === undefined ? -1 : lines.findIndex((line) => context.getMarkers(intent, line) > 0);
    const start = Math.max(0, (markerIndex >= 0 ? markerIndex : 0) - 1);
    return lines
      .slice(start, start + 3)
      .join('\n')
      .substring(0, 200);
  } catch {
    return '';
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
