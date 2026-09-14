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

export interface HybridRankingWeights {
  lexical: number;
  vector: number;
  graph: number;
  history: number;
  freshness: number;
}

export const DEFAULT_HYBRID_RANKING_WEIGHTS: HybridRankingWeights = {
  lexical: 0.35,
  vector: 0.3,
  graph: 0.2,
  history: 0.1,
  freshness: 0.05,
};

export interface HybridRankingOutput {
  total: number;
  lexical: number;
  vector: number;
  graph: number;
  history: number;
  freshness: number;
  whyThisResult: string[];
}

/**
 * Normalize caller-provided weights without allowing NaN, infinity, negative
 * values, or an all-zero configuration to poison a public ranking response.
 * The result always sums to one, making the score comparable across callers.
 */
export function normalizeHybridRankingWeights(
  input: Partial<HybridRankingWeights> = {},
): HybridRankingWeights {
  const valueFor = (key: keyof HybridRankingWeights): number => {
    const supplied = input[key];
    return typeof supplied === 'number' && Number.isFinite(supplied) && supplied >= 0
      ? supplied
      : DEFAULT_HYBRID_RANKING_WEIGHTS[key];
  };
  const values: HybridRankingWeights = {
    lexical: valueFor('lexical'),
    vector: valueFor('vector'),
    graph: valueFor('graph'),
    history: valueFor('history'),
    freshness: valueFor('freshness'),
  };
  const total = Object.values(values).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { ...DEFAULT_HYBRID_RANKING_WEIGHTS };
  return {
    lexical: values.lexical / total,
    vector: values.vector / total,
    graph: values.graph / total,
    history: values.history / total,
    freshness: values.freshness / total,
  };
}

function tokens(value: string): string[] {
  return value
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_$]+/u)
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
  const documentLength = Math.max(1, contentTokens.length);
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const token of queryTokens) {
    const frequency = frequencies.get(token) ?? 0;
    const termFrequency =
      frequency > 0
        ? (frequency * (k1 + 1)) /
          (frequency + k1 * (1 - b + b * (documentLength / Math.max(documentLength, 32))))
        : 0;
    const pathBoost = pathTokens.includes(token) ? 1.35 : 0;
    score += termFrequency + pathBoost;
  }
  const exactPhrase =
    queryTokens.length > 1 && tokens(content).join(' ').includes(queryTokens.join(' '));
  const phraseBoost = exactPhrase ? 0.5 : 0;
  return Math.min(1, (score + phraseBoost) / (queryTokens.length * 2.5));
}

export function rankHybrid(
  input: HybridRankingInput,
  configuredWeights?: Partial<HybridRankingWeights>,
): HybridRankingOutput {
  const lexical = lexicalRelevance(input.query, input.filePath, input.content);
  const vector = safeScore(input.vectorScore) ?? 0;
  const graph = safeScore(input.graphScore) ?? 0;
  const history = safeScore(input.historyScore ?? 0.5) ?? 0.5;
  const freshnessAvailable = input.freshnessScore !== undefined;
  const freshness = safeScore(input.freshnessScore ?? 0.5) ?? 0.5;
  const weights = normalizeHybridRankingWeights(configuredWeights);
  const total =
    safeScore(
      Math.round(
        (lexical * weights.lexical +
          vector * weights.vector +
          graph * weights.graph +
          history * weights.history +
          freshness * weights.freshness) *
          100,
      ) / 100,
    ) ?? 0;
  const whyThisResult: string[] = [];
  if (lexical > 0) whyThisResult.push(`lexical match ${(lexical * 100).toFixed(0)}%`);
  if (vector > 0) whyThisResult.push(`semantic/vector ${(vector * 100).toFixed(0)}%`);
  if (graph > 0) whyThisResult.push(`graph relatedness ${(graph * 100).toFixed(0)}%`);
  if (history !== 0.5) whyThisResult.push(`history signal ${(history * 100).toFixed(0)}%`);
  if (freshness < 1) whyThisResult.push('freshness penalty applied');
  if (!freshnessAvailable) whyThisResult.push('freshness unavailable; neutral prior used');
  if (whyThisResult.length === 0)
    whyThisResult.push('no strong ranking signal; inspect source evidence');
  return { total, lexical, vector, graph, history, freshness, whyThisResult };
}
