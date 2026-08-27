/**
 * Context Window Budget Optimizer — Type Definitions
 */

export interface ContextItem {
  path: string;
  tokens: number;
  relevanceScore: number;
}

export interface ContextBudgetPlan {
  totalTokens: number;
  totalRelevance: number;
  selectedItems: ContextItem[];
  excludedItems: ContextItem[];
}

export interface BudgetOptimizerConfig {
  strategy?: 'greedy' | 'dp' | 'adaptive';
  minTokens?: number;
  maxTokens?: number;
}
