import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { stableHash } from '../../utils/hash.js';

/** Numeric, source-free signals used by the online search preference model. */
export interface SearchRankingFeatures {
  lexical: number;
  vector: number;
  graph: number;
  history: number;
  freshness: number;
  fileType: number;
  pathDepth: number;
  canonical: number;
}

export const SEARCH_RANKING_FEATURE_NAMES = [
  'lexical',
  'vector',
  'graph',
  'history',
  'freshness',
  'fileType',
  'pathDepth',
  'canonical',
] as const;

const searchRankingFeaturesSchema = z.object({
  lexical: z.number().finite().min(0).max(1),
  vector: z.number().finite().min(0).max(1),
  graph: z.number().finite().min(0).max(1),
  history: z.number().finite().min(0).max(1),
  freshness: z.number().finite().min(0).max(1),
  fileType: z.number().finite().min(0).max(1),
  pathDepth: z.number().finite().min(0).max(1),
  canonical: z.number().finite().min(0).max(1),
});

const feedbackSchema = z.enum(['selected', 'opened', 'included', 'skipped']);
export type SearchFeedback = z.infer<typeof feedbackSchema>;

export interface RecordSearchFeedbackInput {
  query: string;
  resultPath: string;
  position: number;
  feedback: SearchFeedback;
  features: SearchRankingFeatures;
  agentName?: string;
}

export interface SearchRerankCandidate {
  path: string;
  baselineScore: number;
  features: SearchRankingFeatures;
}

export interface SearchRerankResult extends SearchRerankCandidate {
  score: number;
  learnedScore: number;
}

export interface SearchRankerStatus {
  active: boolean;
  model: 'deterministic-online-pairwise-v1';
  observations: number;
  positiveObservations: number;
  negativeObservations: number;
  minimumObservations: number;
  limitation: string | null;
}

export interface LearnedRerankerOptions {
  minimumObservations?: number;
  learningRate?: number;
  regularization?: number;
  maxTrainingRows?: number;
  projectRoot?: string;
}

interface StoredInteraction {
  queryHash: string;
  feedback: SearchFeedback;
  features: SearchRankingFeatures;
}

const DEFAULT_WEIGHTS: SearchRankingFeatures = {
  lexical: 0.27,
  vector: 0.25,
  graph: 0.14,
  history: 0.08,
  freshness: 0.08,
  fileType: 0.05,
  pathDepth: 0.04,
  canonical: 0.09,
};

const POSITIVE_FEEDBACK = new Set<SearchFeedback>(['selected', 'opened', 'included']);

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function normalizeFeatures(input: SearchRankingFeatures): SearchRankingFeatures {
  return {
    lexical: clamp(input.lexical),
    vector: clamp(input.vector),
    graph: clamp(input.graph),
    history: clamp(input.history),
    freshness: clamp(input.freshness),
    fileType: clamp(input.fileType),
    pathDepth: clamp(input.pathDepth),
    canonical: clamp(input.canonical),
  };
}

function featureDifference(
  positive: SearchRankingFeatures,
  negative: SearchRankingFeatures,
): SearchRankingFeatures {
  return {
    lexical: positive.lexical - negative.lexical,
    vector: positive.vector - negative.vector,
    graph: positive.graph - negative.graph,
    history: positive.history - negative.history,
    freshness: positive.freshness - negative.freshness,
    fileType: positive.fileType - negative.fileType,
    pathDepth: positive.pathDepth - negative.pathDepth,
    canonical: positive.canonical - negative.canonical,
  };
}

function dot(left: SearchRankingFeatures, right: SearchRankingFeatures): number {
  return SEARCH_RANKING_FEATURE_NAMES.reduce((sum, name) => sum + left[name] * right[name], 0);
}

function sigmoid(value: number): number {
  if (value >= 35) return 1;
  if (value <= -35) return 0;
  return 1 / (1 + Math.exp(-value));
}

function normalizeResultPath(resultPath: string): string {
  const normalized = resultPath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    normalized.length === 0 ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((part) => part === '..')
  ) {
    throw new Error('Search feedback resultPath must be a project-relative path.');
  }
  return normalized;
}

function agentKey(agentName: string | undefined): string {
  return stableHash(agentName?.trim() || 'anonymous').slice(0, 32);
}

/**
 * A privacy-preserving online pairwise reranker.
 *
 * It deliberately stores only query hashes, relative result paths and
 * numeric features. Until both positive and negative evidence reach the
 * configured threshold, it returns the deterministic hybrid order unchanged.
 * This makes the learned layer an evidence-backed opt-in improvement rather
 * than a silent source of unstable ranking decisions.
 */
export class LearnedSearchReranker {
  private readonly minimumObservations: number;
  private readonly learningRate: number;
  private readonly regularization: number;
  private readonly maxTrainingRows: number;
  private readonly projectRoot: string | undefined;

  constructor(
    private readonly db: DatabaseSync,
    private readonly projectId: number,
    options: LearnedRerankerOptions = {},
  ) {
    this.minimumObservations = Number.isSafeInteger(options.minimumObservations)
      ? Math.max(2, options.minimumObservations!)
      : 50;
    this.learningRate = Number.isFinite(options.learningRate)
      ? Math.min(1, Math.max(0.001, options.learningRate!))
      : 0.08;
    this.regularization = Number.isFinite(options.regularization)
      ? Math.min(1, Math.max(0, options.regularization!))
      : 0.01;
    this.maxTrainingRows = Number.isSafeInteger(options.maxTrainingRows)
      ? Math.min(20_000, Math.max(100, options.maxTrainingRows!))
      : 5_000;
    this.projectRoot = options.projectRoot;
  }

  recordFeedback(input: RecordSearchFeedbackInput): {
    id: number;
    status: SearchRankerStatus;
  } {
    const query = input.query.trim();
    if (query.length === 0 || query.length > 8_000) {
      throw new Error('Search feedback query must contain 1..8000 characters.');
    }
    if (!Number.isSafeInteger(input.position) || input.position < 1 || input.position > 1000) {
      throw new Error('Search feedback position must be an integer between 1 and 1000.');
    }
    const resultPath = normalizeResultPath(input.resultPath);
    const features = searchRankingFeaturesSchema.parse(normalizeFeatures(input.features));
    if (this.projectRoot && /^[A-Za-z]:\//.test(this.projectRoot.replace(/\\/g, '/'))) {
      // The root is accepted as a seam for callers that already validated it.
      // No absolute path is stored or passed to a process here.
      void this.projectRoot;
    }
    const result = this.db
      .prepare(
        `INSERT INTO search_interactions
         (project_id, agent_key, query_hash, result_path, position, feedback, features)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.projectId,
        agentKey(input.agentName),
        stableHash(query),
        resultPath,
        input.position,
        input.feedback,
        JSON.stringify(features),
      );
    return { id: Number(result.lastInsertRowid), status: this.getStatus() };
  }

  getStatus(): SearchRankerStatus {
    const rows = this.db
      .prepare(
        `SELECT feedback, COUNT(*) AS count
         FROM search_interactions
         WHERE project_id = ?
         GROUP BY feedback`,
      )
      .all(this.projectId) as Array<{ feedback: string; count: number }>;
    const observations = rows.reduce((sum, row) => sum + Number(row.count), 0);
    const positiveObservations = rows
      .filter((row) => POSITIVE_FEEDBACK.has(row.feedback as SearchFeedback))
      .reduce((sum, row) => sum + Number(row.count), 0);
    const negativeObservations = rows
      .filter((row) => row.feedback === 'skipped')
      .reduce((sum, row) => sum + Number(row.count), 0);
    const active =
      observations >= this.minimumObservations &&
      positiveObservations > 0 &&
      negativeObservations > 0;
    return {
      active,
      model: 'deterministic-online-pairwise-v1',
      observations,
      positiveObservations,
      negativeObservations,
      minimumObservations: this.minimumObservations,
      limitation: active
        ? null
        : `Cold-start deterministic ranking remains active until ${this.minimumObservations} observations with both positive and skipped feedback exist.`,
    };
  }

  rerank(candidates: readonly SearchRerankCandidate[]): {
    results: SearchRerankResult[];
    status: SearchRankerStatus;
  } {
    const status = this.getStatus();
    if (!status.active) {
      return {
        results: candidates.map((candidate) => ({
          ...candidate,
          baselineScore: clamp(candidate.baselineScore),
          score: clamp(candidate.baselineScore),
          learnedScore: clamp(candidate.baselineScore),
        })),
        status,
      };
    }
    const weights = this.trainWeights();
    const results = candidates.map((candidate) => {
      const features = normalizeFeatures(candidate.features);
      const learnedScore = sigmoid(dot(weights, features));
      const baselineScore = clamp(candidate.baselineScore);
      // Keep the measured deterministic score meaningful while allowing the
      // learned preference to break ties and correct repeated blind spots.
      const score = Math.round((baselineScore * 0.4 + learnedScore * 0.6) * 10_000) / 10_000;
      return { ...candidate, baselineScore, features, learnedScore, score };
    });
    results.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    return { results, status };
  }

  private trainWeights(): SearchRankingFeatures {
    const rows = this.db
      .prepare(
        `SELECT query_hash, feedback, features
         FROM search_interactions
         WHERE project_id = ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(this.projectId, this.maxTrainingRows) as Array<{
      query_hash: string;
      feedback: string;
      features: string;
    }>;
    const groups = new Map<
      string,
      { positives: SearchRankingFeatures[]; negatives: SearchRankingFeatures[] }
    >();
    for (const row of rows) {
      const parsed = parseStoredInteraction(row);
      if (!parsed) continue;
      const group = groups.get(parsed.queryHash) ?? { positives: [], negatives: [] };
      if (POSITIVE_FEEDBACK.has(parsed.feedback)) group.positives.push(parsed.features);
      else group.negatives.push(parsed.features);
      groups.set(parsed.queryHash, group);
    }

    const weights = { ...DEFAULT_WEIGHTS };
    for (const group of groups.values()) {
      for (const positive of group.positives) {
        for (const negative of group.negatives) {
          const difference = featureDifference(positive, negative);
          const probability = sigmoid(dot(weights, difference));
          const gradient = (1 - probability) * this.learningRate;
          for (const name of SEARCH_RANKING_FEATURE_NAMES) {
            weights[name] = clamp(
              weights[name] + gradient * difference[name] - this.regularization * weights[name],
            );
          }
        }
      }
    }
    return weights;
  }
}

function parseStoredInteraction(row: {
  query_hash: string;
  feedback: string;
  features: string;
}): StoredInteraction | null {
  const feedback = feedbackSchema.safeParse(row.feedback);
  if (!feedback.success) return null;
  try {
    const features = searchRankingFeaturesSchema.safeParse(JSON.parse(row.features) as unknown);
    return features.success
      ? { queryHash: row.query_hash, feedback: feedback.data, features: features.data }
      : null;
  } catch {
    return null;
  }
}

/** Build safe feature defaults from a semantic-search result breakdown. */
export function featuresFromSearchResult(input: {
  lexical?: number;
  vector?: number;
  graph?: number;
  history?: number;
  freshness?: number;
  path: string;
  canonical?: boolean;
}): SearchRankingFeatures {
  const depth = input.path.split(/[\\/]/).filter(Boolean).length;
  const extension = input.path.toLowerCase().split('.').pop() ?? '';
  const fileType = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(extension) ? 1 : 0.5;
  return normalizeFeatures({
    lexical: input.lexical ?? 0,
    vector: input.vector ?? 0,
    graph: input.graph ?? 0,
    history: input.history ?? 0.5,
    freshness: input.freshness ?? 0.5,
    fileType,
    pathDepth: 1 / Math.max(1, depth),
    canonical: input.canonical ? 1 : 0,
  });
}
