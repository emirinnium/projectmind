export type IntentType = 'read' | 'write' | 'validate' | 'transform';

export interface IntentQuery {
  text: string;
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
}
