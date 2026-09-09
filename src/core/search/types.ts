export type IntentType = 'read' | 'write' | 'validate' | 'transform';
export type TaskType = 'bug fix' | 'feature' | 'refactor' | 'test';

/**
 * Describes how the semantic part of a search result was obtained.
 *
 * Keeping this separate from `source` is intentional: an embedding-backed
 * result may still have a rank-derived score when the graph did not expose
 * the underlying similarity value. Callers can therefore decide how much
 * confidence to place in a result instead of treating every embedding label
 * as equally strong evidence.
 */
export type SemanticEvidence = 'measured' | 'rank-derived' | 'structural-heuristic' | 'lexical';

export interface IntentQuery {
  naturalLanguage?: string;
  /** Deprecated alias — kept for backward compatibility. */
  text?: string;
  structuralHints?: string[];
  expectedOutputs?: string[];
  context?: string;
  filePath?: string;
}

export interface HybridScore {
  semantic: number;
  structural: number;
  intent: number;
  total: number;
}

export interface SearchResult {
  filePath: string;
  score: HybridScore;
  rank: number;
  snippet?: string;
  source?: 'embedding' | 'lexical';
  semanticEvidence?: SemanticEvidence;
  scoreBreakdown?: {
    lexical: number;
    vector: number;
    graph: number;
    history: number;
    freshness: number;
  };
  whyThisResult?: string[];
}
