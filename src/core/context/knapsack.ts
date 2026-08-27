// Context Window Budget Optimizer - Knapsack Solver
// Solves the 0/1 knapsack problem for selecting files within a token budget

interface ContextItem {
  path: string;
  tokens: number;
  relevanceScore: number;
}

interface ContextBudgetPlan {
  totalTokens: number;
  totalRelevance: number;
  selectedItems: ContextItem[];
  excludedItems: ContextItem[];
}

/**
 * Solves the 0/1 knapsack problem for context selection
 * @param items Array of context items with their token cost and relevance score
 * @param budget Maximum token budget
 * @returns Optimal selection of items within budget
 */
export function selectWithinBudget(
  items: ContextItem[],
  budget: number
): ContextBudgetPlan {
  // Sort by value density (relevance per token) descending
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

/**
 * Dynamic programming solution for knapsack (more accurate but slower)
 * @param items Array of context items
 * @param budget Maximum token budget
 */
export function knapsackDp(
  items: ContextItem[],
  budget: number
): ContextBudgetPlan {
  const n = items.length;
  const dp: number[][] = Array(n + 1)
    .fill(0)
    .map(() => Array(budget + 1).fill(0));

  // Build DP table
  for (let i = 1; i <= n; i++) {
    for (let w = 1; w <= budget; w++) {
      if (items[i - 1].tokens <= w) {
        dp[i][w] = Math.max(
          dp[i - 1][w],
          dp[i - 1][w - items[i - 1].tokens] + items[i - 1].relevanceScore
        );
      } else {
        dp[i][w] = dp[i - 1][w];
      }
    }
  }

  // Traceback to find selected items
  let w = budget;
  let i = n;
  const selectedItems: ContextItem[] = [];
  let totalTokens = 0;
  let totalRelevance = dp[n][budget];

  while (i > 0 && w > 0) {
    if (dp[i][w] !== dp[i - 1][w]) {
      selectedItems.push(items[i - 1]);
      w -= items[i - 1].tokens;
      i--;
    } else {
      i--;
    }
  }

  // Find excluded items
  const selectedPaths = new Set(selectedItems.map((item) => item.path));
  const excludedItems = items.filter((item) => !selectedPaths.has(item.path));

  return {
    totalTokens,
    totalRelevance,
    selectedItems,
    excludedItems,
  };
}