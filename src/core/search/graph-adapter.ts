import { cosineSimilarity, safeScore } from './scoring.js';

export interface KGGraphLike {
  getFileByPath(path: string): { id?: number; path: string; hash?: string } | null;
  getImports?(fileId: number): Array<{ source: string; named: string[]; kind: string }>;
  getDependents?(fileId: number): Array<{ source: string; named: string[]; kind: string }>;
  findSimilarFiles?(
    embedding: number[],
    threshold?: number,
    limit?: number,
  ): Array<{ path: string; score?: number }>;
  getHistoryScore?(filePath: string): number | undefined;
}

export interface KgAdapterSource {
  getFileByPath(path: string): {
    id?: number;
    path?: string;
    relativePath?: string;
    hash?: string;
  } | null;
  getImports?(fileId: number): Array<{ source: string; named?: string[]; kind?: string }>;
  getDependents?(fileId: number): Array<{ path?: string; relativePath?: string }>;
  findSimilarFiles?(
    embedding: number[],
    threshold?: number,
    limit?: number,
  ): Array<{ id?: number; path?: string; relativePath?: string; score?: number }>;
  /** Optional access to the persisted vector so measured similarity is kept. */
  getFileEmbedding?(fileId: number): number[] | null;
  getHistoryScore?(filePath: string): number | undefined;
}

/**
 * Adapt a KnowledgeGraph-shaped object to the engine's minimal graph
 * contract. When possible, compute similarity from the persisted vector;
 * otherwise preserve a supplied score and let the engine label missing
 * scores as rank-derived.
 */
export function createKgGraphAdapter(kg: KgAdapterSource): KGGraphLike {
  return {
    getFileByPath: (path) => {
      const file = kg.getFileByPath(path);
      if (!file) return null;
      return { id: file.id, path: file.relativePath ?? file.path ?? path, hash: file.hash };
    },
    getImports: kg.getImports
      ? (fileId) =>
          kg.getImports!(fileId).map((item) => ({
            source: item.source,
            named: item.named ?? [],
            kind: item.kind ?? 'import',
          }))
      : undefined,
    getDependents: kg.getDependents
      ? (fileId) =>
          kg.getDependents!(fileId).map((file) => ({
            source: file.relativePath ?? file.path ?? '',
            named: [],
            kind: 'import',
          }))
      : undefined,
    findSimilarFiles: kg.findSimilarFiles
      ? (embedding, threshold, limit) =>
          kg.findSimilarFiles!(embedding, threshold, limit).map((file) => {
            const persisted =
              typeof file.id === 'number' && kg.getFileEmbedding
                ? kg.getFileEmbedding(file.id)
                : null;
            const measured = persisted
              ? cosineSimilarity(embedding, persisted)
              : safeScore(file.score);
            return {
              path: file.relativePath ?? file.path ?? '',
              score: measured,
            };
          })
      : undefined,
    getHistoryScore: kg.getHistoryScore ? (filePath) => kg.getHistoryScore!(filePath) : undefined,
  };
}
