/**
 * Context Window Budget Optimizer — selectors.
 *
 * F30: the DP selector is VALUE-based, not budget-based: relevance scores are
 * quantized to integer values (round(score * DP_VALUE_SCALE)) and the DP
 * minimizes tokens for each achievable total value. Memory is therefore
 * O(n * totalValue) with totalValue <= n * DP_MAX_RELEVANCE * DP_VALUE_SCALE
 * — independent of the token budget, so budgets of 200k tokens cost nothing
 * extra. Budgets only enter in the final "best value with tokens <= budget"
 * scan.
 */
import type { ContextItem } from './types.js';

/** Result of a selector: chosen items plus accounting. */
export interface SelectionResult {
  selectedItems: ContextItem[];
  excludedItems: ContextItem[];
  /** Allocated tokens = sum of selected item tokens (real estimates). */
  totalTokens: number;
  totalRelevance: number;
}

/** Relevance quantization scale (score -> integer value). */
export const DP_VALUE_SCALE = 500;
/**
 * Maximum relevance honored by the DP quantizer. Task-type boosts
 * (applyTaskTypeBoosts) multiply scores AFTER validation and can push them up
 * to ~1.95, so the clamp must stay above 1 or boosted items would all
 * quantize to the same value and lose to unboosted items on the DP's
 * min-token tie-break. The bound also keeps totalValue <= n * 1000, capping
 * the DP table width against unbounded direct-API scores (OOM footgun).
 */
export const DP_MAX_RELEVANCE = 2;
/** Above this item count the optimizer falls back to greedy (F32). */
export const DP_MAX_ITEMS = 60;
/** Above this total quantized value the optimizer falls back to greedy. */
export const DP_TOTAL_VALUE_CAP = 100_000;

/** Clamp a relevance score into the quantizer range; NaN collapses to 0. */
function quantizedValue(score: number): number {
  const clamped = Math.min(DP_MAX_RELEVANCE, Math.max(0, score));
  return Number.isFinite(clamped) ? Math.round(clamped * DP_VALUE_SCALE) : 0;
}

function emptyResult(items: ContextItem[]): SelectionResult {
  return { selectedItems: [], excludedItems: [...items], totalTokens: 0, totalRelevance: 0 };
}

function summarize(items: ContextItem[], selected: ContextItem[]): SelectionResult {
  const selectedSet = new Set(selected);
  return {
    selectedItems: selected,
    excludedItems: items.filter((it) => !selectedSet.has(it)),
    totalTokens: selected.reduce((sum, it) => sum + it.tokens, 0),
    totalRelevance: selected.reduce((sum, it) => sum + it.relevanceScore, 0),
  };
}

/**
 * Greedy selector for context items within a token budget.
 * Sorts by relevance density (relevance / tokens) descending and picks
 * items until the budget is exhausted.
 */
export function greedySelector(items: ContextItem[], budget: number): SelectionResult {
  const sortedItems = [...items].sort((a, b) => {
    const densityA = a.relevanceScore / Math.max(a.tokens, 1);
    const densityB = b.relevanceScore / Math.max(b.tokens, 1);
    return densityB - densityA;
  });

  let totalTokens = 0;
  const selectedItems: ContextItem[] = [];

  for (const item of sortedItems) {
    if (totalTokens + item.tokens <= budget) {
      selectedItems.push(item);
      totalTokens += item.tokens;
    }
  }

  return summarize(items, selectedItems);
}

/** Whether the DP selector can run within its memory/time bounds (F32). */
export function dpApplicable(items: ContextItem[]): boolean {
  if (items.length === 0 || items.length > DP_MAX_ITEMS) return false;
  let totalValue = 0;
  for (const it of items) {
    // Must match dpSelector's quantization EXACTLY (same clamp + scale), or
    // the applicability check and the table width would disagree.
    totalValue += quantizedValue(it.relevanceScore);
    if (totalValue > DP_TOTAL_VALUE_CAP) return false;
  }
  return true;
}

/**
 * F30: memory-safe 0/1 knapsack over quantized VALUE (not over the token
 * budget). dp[v] = minimum tokens needed to reach exactly total value v using
 * the items processed so far; keep[i][v] records whether item i participates
 * in the optimal solution for value v. Afterwards the largest value with
 * dp[v] <= budget is chosen and reconstructed.
 *
 * Safe for budgets up to 200k+ tokens: complexity is O(n * totalValue) with
 * totalValue <= min(n * DP_MAX_RELEVANCE * DP_VALUE_SCALE, DP_TOTAL_VALUE_CAP).
 */
export function dpSelector(items: ContextItem[], budget: number): SelectionResult {
  const n = items.length;
  if (n === 0) return emptyResult(items);

  // Clamp relevance to [0, DP_MAX_RELEVANCE] BEFORE quantization. The upper
  // bound is 2 (not 1) because task-type boosts legitimately push scores above
  // 1 after validation; clamping to 1 collapsed every boosted score onto the
  // same quantized value and let the DP's min-token tie-break prefer
  // unboosted items. The bound also caps the DP table width (totalValue + 1),
  // so unbounded scores passed by direct callers cannot allocate an unbounded
  // table (OOM footgun). NaN -> 0.
  const values = items.map((it) => quantizedValue(it.relevanceScore));
  const weights = items.map((it) => Math.max(1, Math.floor(it.tokens)));

  // Zero-value items can never improve the objective; exclude them up front
  // (also keeps the keep-table reconstruction degenerate-free).
  const candidateIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (values[i] > 0 && weights[i] <= budget) candidateIdx.push(i);
  }
  if (candidateIdx.length === 0) return emptyResult(items);

  const m = candidateIdx.length;
  let totalValue = 0;
  for (const i of candidateIdx) totalValue += values[i];

  const width = totalValue + 1;
  let dpPrev = new Float64Array(width).fill(Infinity);
  let dpCur = new Float64Array(width);
  dpPrev[0] = 0;
  const keep = new Uint8Array(m * width);

  for (let k = 0; k < m; k++) {
    const idx = candidateIdx[k];
    const val = values[idx];
    const w = weights[idx];
    dpCur.set(dpPrev);
    for (let v = val; v <= totalValue; v++) {
      const prev = dpPrev[v - val];
      if (prev !== Infinity && prev + w < dpCur[v]) {
        dpCur[v] = prev + w;
        keep[k * width + v] = 1;
      }
    }
    const tmp = dpPrev;
    dpPrev = dpCur;
    dpCur = tmp;
  }

  // Pick the maximum total value whose minimal token cost fits the budget.
  let bestValue = 0;
  for (let v = totalValue; v >= 0; v--) {
    if (dpPrev[v] <= budget) {
      bestValue = v;
      break;
    }
  }

  // Reconstruct the selected items.
  const selected: ContextItem[] = [];
  let v = bestValue;
  for (let k = m - 1; k >= 0; k--) {
    if (keep[k * width + v]) {
      selected.push(items[candidateIdx[k]]);
      v -= values[candidateIdx[k]];
    }
  }
  selected.reverse();

  return summarize(items, selected);
}
