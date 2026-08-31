export type IntentType = 'read' | 'write' | 'validate' | 'transform';
export type TaskType = 'bug fix' | 'feature' | 'refactor' | 'test';

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
}
