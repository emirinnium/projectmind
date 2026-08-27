// Context Window Budget Optimizer - Greedy Selector
import type { ContextItem, ContextBudgetPlan } from './types.js';

/**
 * Greedy selector for context items within a token budget.
 * Sorts by relevance density (relevance / tokens) descending and picks
 * items until the budget is exhausted.
 * @param items Array of context items with token cost and relevance score
 * @param budget Maximum token budget
 * @returns Selection of items within budget
 */
export function greedySelector(
  items: ContextItem[],
  budget: number
): ContextBudgetPlan {
  const sortedItems = [...items].sort((a, b) => {
    const densityA = a.relevanceScore / Math.max(a.tokens, 1);
    const densityB = b.relevanceScore / Math.max(b.tokens, 1);
    return densityB - densityA;
  });

  let totalTokens = 0;
  let totalRelevance = 0;
  const selectedItems: ContextItem[] = [];
  const excludedItems: ContextItem[] = [];

  for (const item of sortedItems) {
    if (totalTokens + item.tokens <= budget) {
      selectedItems.push(item);
      totalTokens += item.tokens;
      totalRelevance += item.relevanceScore;
    } else {
      excludedItems.push(item);
    }
  }

  return {
    totalTokens,
    totalRelevance,
    selectedItems,
    excludedItems,
  };
}
