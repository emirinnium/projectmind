/**
 * Context Window Budget Optimizer
 */
import type { ContextItem, ContextBudgetPlan, BudgetOptimizerConfig } from './types.js';

export class ContextBudgetOptimizer {
  private strategy: 'greedy' | 'dp' | 'adaptive';

  constructor(config: BudgetOptimizerConfig = {}) {
    this.strategy = config.strategy ?? 'greedy';
  }

  setStrategy(strategy: 'greedy' | 'dp' | 'adaptive'): void {
    this.strategy = strategy;
  }

  optimize(items: ContextItem[], budget: number): ContextBudgetPlan {
    if (budget < 0) throw new Error('Budget must be >= 0');
    for (const item of items) {
      if (item.tokens < 1) throw new Error('Item tokens must be >= 1');
    }

    if (this.strategy === 'greedy') {
      return this.greedySelect(items, budget);
    }
    // dp and adaptive fall back to greedy for this release
    return this.greedySelect(items, budget);
  }

  private greedySelect(items: ContextItem[], budget: number): ContextBudgetPlan {
    const sorted = [...items].sort((a, b) => {
      const da = a.relevanceScore / Math.max(a.tokens, 1);
      const db = b.relevanceScore / Math.max(b.tokens, 1);
      return db - da;
    });

    let totalTokens = 0;
    let totalRelevance = 0;
    const selectedItems: ContextItem[] = [];
    const excludedItems: ContextItem[] = [];

    for (const item of sorted) {
      if (totalTokens + item.tokens <= budget) {
        selectedItems.push(item);
        totalTokens += item.tokens;
        totalRelevance += item.relevanceScore;
      } else {
        excludedItems.push(item);
      }
    }

    return { totalTokens, totalRelevance, selectedItems, excludedItems };
  }
}
