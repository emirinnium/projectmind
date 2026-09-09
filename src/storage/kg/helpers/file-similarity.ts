import type { SQLOutputValue } from 'node:sqlite';

import { getVecIndex } from '../../../core/embeddings/vector-index.js';

import { cosineSimilarity } from '../../../parser/embeddings.js';

import type { FileInfo } from '../types.js';

import type { KgContext } from './context.js';
import { decodeEmbedding } from '../../../core/embeddings/embedding-codec.js';
import { getAllFiles, mapFileInfo } from './file-queries.js';

function findSimilarIn(
  embedding: number[],
  candidates: { id: number; embedding: number[] }[],
  threshold: number,
  topK: number,
): { id: number; score: number }[] {
  return candidates
    .map((candidate) => ({
      id: candidate.id,
      score: cosineSimilarity(embedding, candidate.embedding),
    }))
    .filter((result) => result.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * SQLite does not promise that an `IN (...)` query preserves the order of its
 * parameters. Similarity callers do rely on the ANN/brute-force ranking, so
 * restore that order explicitly after fetching the full file rows.
 */
function mapFilesInRequestedOrder(
  rows: Record<string, SQLOutputValue>[],
  ids: readonly number[],
): FileInfo[] {
  const filesById = new Map<number, FileInfo>();
  for (const row of rows) {
    const file = mapFileInfo(row);
    filesById.set(file.id, file);
  }

  const orderedFiles: FileInfo[] = [];
  for (const id of ids) {
    const file = filesById.get(id);
    if (file) orderedFiles.push(file);
  }
  return orderedFiles;
}

export function findSimilarFiles(
  ctx: KgContext,
  targetEmbedding: number[],
  threshold = 0.7,
  limit = 10,
): FileInfo[] {
  if (targetEmbedding.length === 0) return getAllFiles(ctx).slice(0, limit);

  const vecIndex = getVecIndex(ctx.db, targetEmbedding.length);
  if (vecIndex.isAvailable()) {
    const overfetch = Math.max(limit * 3, 30);
    const rawMatches = vecIndex.findSimilar(targetEmbedding, overfetch, ctx.currentProjectId);
    const goodIds: number[] = [];
    for (const match of rawMatches) {
      const score = 1 - match.distance;
      if (score >= threshold) goodIds.push(match.id);
    }

    if (goodIds.length > 0) {
      const ids = goodIds.slice(0, limit);
      const placeholders = ids.map(() => '?').join(',');
      const resultRows = ctx.db
        .prepare(`SELECT * FROM files WHERE id IN (${placeholders})`)
        .all(...ids) as Record<string, SQLOutputValue>[];
      return mapFilesInRequestedOrder(resultRows, ids);
    }
  }

  const allFiles = getAllFiles(ctx);
  const ids = allFiles.map((file) => file.id);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const rows = ctx.db
    .prepare(`SELECT id, embedding FROM files WHERE id IN (${placeholders})`)
    .all(...ids) as { id: number; embedding: SQLOutputValue | null }[];

  const embeddingMap = new Map<number, number[]>();
  for (const row of rows) {
    if (!row.embedding) continue;
    const decoded = decodeEmbedding(row.embedding);
    if (decoded.length > 0) embeddingMap.set(row.id, decoded);
  }

  const candidates: { id: number; embedding: number[] }[] = [];
  for (const file of allFiles) {
    const embedding = embeddingMap.get(file.id);
    if (embedding) candidates.push({ id: file.id, embedding });
  }

  const matches = findSimilarIn(targetEmbedding, candidates, threshold, limit);
  const matchIds = matches.map((match) => match.id);
  if (matchIds.length === 0) return [];

  const matchPlaceholders = matchIds.map(() => '?').join(',');
  const resultRows = ctx.db
    .prepare(`SELECT * FROM files WHERE id IN (${matchPlaceholders})`)
    .all(...matchIds) as Record<string, SQLOutputValue>[];
  return mapFilesInRequestedOrder(resultRows, matchIds);
}
