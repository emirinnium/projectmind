import type { IntentQuery } from './types.js';

export interface SemanticSearchOptions {
  limit?: number;
  threshold?: number;
}

export async function searchSemantic(
  query: string | IntentQuery,
  embeddingGenerator: (text: string) => Promise<number[]>,
  cosineSimilarity: (a: number[], b: number[]) => number,
  fileEmbeddings: Map<string, number[]>,
  options: SemanticSearchOptions = {},
): Promise<Array<{ filePath: string; score: number }>> {
  const text = typeof query === 'string' ? query : (query.naturalLanguage ?? query.text ?? '');
  const queryEmbedding = await embeddingGenerator(text);
  const limit = options.limit ?? 5;
  const threshold = options.threshold ?? 0.7;

  const results: Array<{ filePath: string; score: number }> = [];
  for (const [filePath, emb] of fileEmbeddings) {
    const score = cosineSimilarity(queryEmbedding, emb);
    if (score >= threshold) {
      results.push({ filePath, score });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
