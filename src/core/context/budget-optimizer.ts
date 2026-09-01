/**
 * Context Window Budget Optimizer
 *
 * Token-aware ranking note:
 * File relevance is measured as:
 *   relevanceScore = 0.4 * semantic_similarity + 0.3 * structural_centrality + 0.3 * recency
 * (recently changed files get higher recency score from git log).
 * Token estimation uses char_length / 4 heuristic (approximate token-to-char ratio
 * for English/code). The knapsack maximizes Σ relevanceScore subject to Σ tokens ≤ budget.
 *
 * F30/F32: the default strategy is the memory-safe VALUE-based DP
 * (see knapsack.ts), with automatic greedy fallback when n > DP_MAX_ITEMS or
 * the quantized value bound is exceeded. F31: task-type boosts adjust scores
 * BEFORE selection. F33: token accounting is consistent — DP may floor token
 * weights internally, but the plan always reports real estimated tokens.
 */
import fs from 'fs';
import type {
  ContextItem,
  ContextBudgetPlan,
  BudgetOptimizerConfig,
  PlannedFile,
  ExcludedFileEntry,
} from './types.js';
import type { TaskType } from '../search/types.js';
import { greedySelector, dpSelector, dpApplicable, type SelectionResult } from './knapsack.js';
import { logger } from '../../utils/logger.js';

/** Token threshold above which a file is compressed to signature-only. */
const COMPRESSION_HINT_TOKEN_THRESHOLD = 5000;

/**
 * F31: multiplicative boost for items relevant to the current task type.
 * bug fix -> recently changed + error-handling; feature -> semantic-similar +
 * API surface; refactor -> high coupling + tests; test -> test files.
 */
export function taskTypeMultiplier(item: ContextItem, taskType: TaskType): number {
  let m = 1;
  switch (taskType) {
    case 'bug fix':
      if (item.recentlyChanged) m *= 1.5;
      if (item.errorHandling) m *= 1.3;
      break;
    case 'feature':
      if (item.semanticMatch) m *= 1.5;
      if (item.apiSurface) m *= 1.3;
      break;
    case 'refactor':
      m *= 1 + Math.min(1, Math.max(0, item.couplingScore ?? 0)) * 0.5;
      if (item.isTestFile) m *= 1.1;
      break;
    case 'test':
      if (item.isTestFile) m *= 1.6;
      break;
  }
  return m;
}

/** Apply task-type boosts, returning new items (never mutates the input). */
export function applyTaskTypeBoosts(items: ContextItem[], taskType: TaskType): ContextItem[] {
  return items.map((it) => {
    const m = taskTypeMultiplier(it, taskType);
    return m === 1 ? it : { ...it, relevanceScore: it.relevanceScore * m };
  });
}

/** F31: derive a human-readable inclusion reason from item metadata. */
export function deriveInclusionReason(item: ContextItem, taskType?: TaskType): string {
  if (item.semanticMatch) return 'semantic match';
  if (item.importedByQueryFiles) return 'import neighbor';
  if (item.recentlyChanged) return 'recently changed';
  if (taskType === 'bug fix' && item.errorHandling) return 'error-handling file (bug fix)';
  if (taskType === 'feature' && item.apiSurface) return 'API surface (feature)';
  if (taskType === 'refactor' && (item.couplingScore ?? 0) >= 0.5)
    return 'high coupling (refactor)';
  if (item.isTestFile) return 'test file';
  return 'top relevance';
}

export class ContextBudgetOptimizer {
  private strategy: 'greedy' | 'dp' | 'adaptive';
  private taskType?: TaskType;
  private readonly compressionHintFraction: number;

  constructor(config: BudgetOptimizerConfig = {}) {
    // F32: DP is the default strategy (with automatic greedy fallback).
    this.strategy = config.strategy ?? 'dp';
    this.taskType = config.taskType;
    this.compressionHintFraction = config.compressionHintFraction ?? 0.2;
  }

  setStrategy(strategy: 'greedy' | 'dp' | 'adaptive'): void {
    this.strategy = strategy;
  }

  setTaskType(taskType: TaskType | undefined): void {
    this.taskType = taskType;
  }

  optimize(items: ContextItem[], budget: number, taskType?: TaskType): ContextBudgetPlan {
    if (budget < 0) throw new Error('Budget must be >= 0');
    for (const item of items) {
      if (item.tokens < 1) throw new Error('Item tokens must be >= 1');
    }

    const effectiveTask = taskType ?? this.taskType;
    // F31: score adjustment happens BEFORE selection.
    const boosted = effectiveTask ? applyTaskTypeBoosts(items, effectiveTask) : items;
    const selection = this.select(boosted, budget);
    return this.buildPlan(selection, budget, effectiveTask);
  }

  private select(items: ContextItem[], budget: number): SelectionResult {
    if (this.strategy === 'greedy') {
      return greedySelector(items, budget);
    }
    if (this.strategy === 'dp') {
      // F32: automatic greedy fallback when DP bounds are exceeded.
      return dpApplicable(items) ? dpSelector(items, budget) : greedySelector(items, budget);
    }
    // adaptive: DP for small sets, greedy otherwise
    if (items.length <= 15 && dpApplicable(items)) {
      return dpSelector(items, budget);
    }
    return greedySelector(items, budget);
  }

  private buildPlan(
    selection: SelectionResult,
    budget: number,
    taskType?: TaskType,
  ): ContextBudgetPlan {
    const largeThreshold = budget * this.compressionHintFraction;

    const files: PlannedFile[] = selection.selectedItems.map((it) => {
      const large = budget > 0 && it.tokens > largeThreshold;
      const reason = deriveInclusionReason(it, taskType);
      return {
        path: it.path,
        tokens: it.tokens,
        relevanceScore: it.relevanceScore,
        // F33: per-file compression hint for files that dominate the budget.
        inclusionReason: large
          ? `${reason}; signature_only recommended (file alone exceeds ${Math.round(
              this.compressionHintFraction * 100,
            )}% of budget)`
          : reason,
        compressionStrategy: large ? 'signature_only' : undefined,
      };
    });

    const excludedFiles: ExcludedFileEntry[] = selection.excludedItems.map((it) => ({
      path: it.path,
      reason: it.tokens > budget ? 'exceeds entire budget on its own' : 'budget exceeded',
    }));

    return {
      totalTokens: budget,
      // F33: real estimated tokens (sum of item.tokens), not DP weights.
      allocatedTokens: selection.totalTokens,
      files,
      excludedFiles,
      compressionStrategy: ContextBudgetOptimizer.compressionStrategySelector(
        selection.totalTokens,
      ),
      totalRelevance: selection.totalRelevance,
      selectedItems: selection.selectedItems,
      excludedItems: selection.excludedItems,
    };
  }

  /**
   * Token estimator using char/4 heuristic.
   * Falls back to a simple heuristic (100 tokens) if file does not exist.
   */
  static tokenEstimator(filePath: string): number {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return Math.ceil(content.length / 4);
    } catch (e) {
      // File unreadable or missing — fall back to default token estimate.
      logger.warn('Failed to read file for token estimation, using default 100 tokens', {
        filePath,
        error: e instanceof Error ? e.message : String(e),
      });
      return 100;
    }
  }

  /**
   * Compression strategy selector based on file/token size.
   */
  static compressionStrategySelector(tokens: number): 'summary' | 'signature_only' | 'full' {
    if (tokens > COMPRESSION_HINT_TOKEN_THRESHOLD) return 'signature_only';
    if (tokens > 2000) return 'summary';
    return 'full';
  }
}
