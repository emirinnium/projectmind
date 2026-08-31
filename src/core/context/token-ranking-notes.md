# Token-Aware Ranking Notes

## Relevance Measurement
File relevance is measured as:

```
relevanceScore = 0.4 * semantic_similarity + 0.3 * structural_centrality + 0.3 * recency
```

Recently changed files get a higher recency score derived from `git log` (e.g., time since last commit / frequency of changes).

## Token Estimation
Token estimation uses the `char_length / 4` heuristic:

```ts
fs.readFileSync(filePath, 'utf-8').length / 4
```

This approximates the token-to-character ratio for English and code text. If the file does not exist, a simple fallback heuristic (100 tokens) is used.

## Knapsack Optimization
The budget optimizer solves a 0/1 knapsack problem:

- **Weight** = estimated tokens (`tokens`)
- **Value** = `relevanceScore`
- **Constraint** = `Σ tokens ≤ budget`
- **Objective** = maximize `Σ relevanceScore`

Dynamic programming (`dp[i][w]`) reconstructs the optimal subset for small item counts (`≤ 15`); greedy density sorting is used for larger sets to maintain performance.
