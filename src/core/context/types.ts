/**
 * Context Window Budget Optimizer — Type Definitions
 */
import type { TaskType } from '../search/types.js';

export type { TaskType as ContextTaskType } from '../search/types.js';

export interface ContextItem {
  path: string;
  tokens: number;
  relevanceScore: number;
  /** F31 metadata: drives inclusion reasons and task-type boosts. */
  recentlyChanged?: boolean;
  /** File is imported by (or imports) a file matched by the query. */
  importedByQueryFiles?: boolean;
  /** File came from a semantic/embedding match. */
  semanticMatch?: boolean;
  /** File is dominated by error-handling code (bug-fix boost). */
  errorHandling?: boolean;
  /** File exposes public API surface (feature boost). */
  apiSurface?: boolean;
  /** 0..1 coupling centrality (refactor boost). */
  couplingScore?: number;
  /** File is a test file (test boost). */
  isTestFile?: boolean;
}

/** A file included in the context plan (F31 spec shape). */
export interface PlannedFile {
  path: string;
  tokens: number;
  relevanceScore: number;
  inclusionReason: string;
  /** F33: per-file compression hint (large files shrink to signatures). */
  compressionStrategy?: 'summary' | 'signature_only' | 'full';
}

export interface ExcludedFileEntry {
  path: string;
  reason: string;
}

export interface ContextBudgetPlan {
  /** The token budget the optimizer was asked to respect. */
  totalTokens: number;
  /** Tokens actually allocated: sum of files[].tokens (F33 consistency). */
  allocatedTokens: number;
  files: PlannedFile[];
  excludedFiles: ExcludedFileEntry[];
  compressionStrategy?: 'summary' | 'signature_only' | 'full';
  /** Backwards-compatible extras (old plan shape). */
  totalRelevance: number;
  selectedItems: ContextItem[];
  excludedItems: ContextItem[];
}

export interface BudgetOptimizerConfig {
  /** F32: 'dp' is the default; greedy fallback applies automatically. */
  strategy?: 'greedy' | 'dp' | 'adaptive';
  /** F31: task type used to boost relevant items before selection. */
  taskType?: TaskType;
  /**
   * F33: a single file costing more than this fraction of the budget gets a
   * 'signature_only' compression hint. Default 0.2 (20%).
   */
  compressionHintFraction?: number;
}
