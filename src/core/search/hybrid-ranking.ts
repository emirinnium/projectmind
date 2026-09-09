import { safeScore } from './scoring.js';

export interface HybridRankingInput {
  query: string;
  filePath: string;
  content: string;
  vectorScore: number;
  graphScore: number;
  historyScore?: number;
  freshnessScore?: number;
}

export interface HybridRankingOutput {
  total: number;
  lexical: number;
  vector: number;
  graph: number;
  history: number;
  freshness: number;
  whyThisResult: string[];
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .filter((token) => token.length > 1);
}

/**
 * Deterministic BM25-inspired lexical score. It intentionally stays local
 * and dependency-free; vector/graph/history signals are combined here so a
 * result can explain every contribution instead of exposing one opaque score.
 */
export function lexicalRelevance(query: string, filePath: string, content: string): number {
  const queryTokens = [...new Set(tokens(query))];
  if (queryTokens.length === 0) return 0;
  const pathTokens = tokens(filePath);
  const contentTokens = tokens(content);
  const frequencies = new Map<string, number>();
  for (const token of contentTokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  let score = 0;
  for (const token of queryTokens) {
    const frequency = frequencies.get(token) ?? 0;
    const pathBoost = pathTokens.includes(token) ? 2 : 0;
    score += (frequency > 0 ? 1 + Math.log1p(frequency) / 4 : 0) + pathBoost;
  }
  return Math.min(1, score / (queryTokens.length * 3));
}

export function rankHybrid(input: HybridRankingInput): HybridRankingOutput {
  const lexical = lexicalRelevance(input.query, input.filePath, input.content);
  const vector = safeScore(input.vectorScore) ?? 0;
  const graph = safeScore(input.graphScore) ?? 0;
  const history = safeScore(input.historyScore ?? 0.5) ?? 0.5;
  const freshness = safeScore(input.freshnessScore ?? 1) ?? 1;
  const total =
    safeScore(
      Math.round(
        (lexical * 0.35 + vector * 0.3 + graph * 0.2 + history * 0.1 + freshness * 0.05) * 100,
      ) / 100,
    ) ?? 0;
  const whyThisResult: string[] = [];
  if (lexical > 0) whyThisResult.push(`lexical match ${(lexical * 100).toFixed(0)}%`);
  if (vector > 0) whyThisResult.push(`semantic/vector ${(vector * 100).toFixed(0)}%`);
  if (graph > 0) whyThisResult.push(`graph relatedness ${(graph * 100).toFixed(0)}%`);
  if (history !== 0.5) whyThisResult.push(`history signal ${(history * 100).toFixed(0)}%`);
  if (freshness < 1) whyThisResult.push('freshness penalty applied');
  if (whyThisResult.length === 0)
    whyThisResult.push('no strong ranking signal; inspect source evidence');
  return { total, lexical, vector, graph, history, freshness, whyThisResult };
}
