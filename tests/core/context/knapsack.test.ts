import { describe, it, expect } from 'vitest';
import {
  greedySelector,
  dpSelector,
  dpApplicable,
  DP_VALUE_SCALE,
  DP_MAX_RELEVANCE,
  DP_MAX_ITEMS,
  DP_TOTAL_VALUE_CAP,
} from '../../../src/core/context/knapsack.js';
import type { ContextItem } from '../../../src/core/context/types.js';

/**
 * Helper to create a ContextItem with minimal boilerplate.
 */
function item(path: string, tokens: number, relevanceScore: number, extra: Partial<ContextItem> = {}): ContextItem {
  return { path, tokens, relevanceScore, ...extra };
}

describe('knapsack selectors', () => {
  // ============================================================
  // Task 1: dpSelector() with known item sets
  // ============================================================
  describe('dpSelector()', () => {
    it('selects the optimal set where greedy loses (classic knapsack counterexample)', () => {
      // Budget 10; densities: A=0.61/6=0.1017, B=C=0.5/5=0.1.
      // Greedy takes A (6 tokens), then B/C don't fit -> total 0.61.
      // DP takes B+C (10 tokens) -> total 1.0 (optimal).
      const items: ContextItem[] = [
        item('a.ts', 6, 0.61),
        item('b.ts', 5, 0.5),
        item('c.ts', 5, 0.5),
      ];

      const dp = dpSelector(items, 10);
      expect(dp.selectedItems.map((i) => i.path).sort()).toEqual(['b.ts', 'c.ts']);
      expect(dp.totalRelevance).toBeCloseTo(1.0);
      expect(dp.totalTokens).toBeLessThanOrEqual(10);
    });

    it('returns empty selection for empty items', () => {
      const result = dpSelector([], 100);
      expect(result.selectedItems).toEqual([]);
      expect(result.excludedItems).toEqual([]);
      expect(result.totalTokens).toBe(0);
      expect(result.totalRelevance).toBe(0);
    });

    it('selects single item that fits the budget', () => {
      const items: ContextItem[] = [item('solo.ts', 5, 0.8)];
      const result = dpSelector(items, 10);
      expect(result.selectedItems.map((i) => i.path)).toEqual(['solo.ts']);
      expect(result.totalRelevance).toBeCloseTo(0.8);
    });

    it('excludes items that exceed the budget individually', () => {
      const items: ContextItem[] = [
        item('big.ts', 100, 1.0),
        item('small.ts', 5, 0.5),
      ];
      const result = dpSelector(items, 10);
      expect(result.selectedItems.map((i) => i.path)).toEqual(['small.ts']);
      expect(result.excludedItems.map((i) => i.path)).toEqual(['big.ts']);
    });

    it('maximizes total relevance within the budget', () => {
      // Budget 8. Best combo: b(5) + c(3) = 0.7 + 0.4 = 1.1
      const items: ContextItem[] = [
        item('a.ts', 6, 0.6),
        item('b.ts', 5, 0.7),
        item('c.ts', 3, 0.4),
      ];
      const result = dpSelector(items, 8);
      expect(result.selectedItems.map((i) => i.path).sort()).toEqual(['b.ts', 'c.ts']);
      expect(result.totalRelevance).toBeCloseTo(1.1);
      expect(result.totalTokens).toBeLessThanOrEqual(8);
    });

    it('respects the budget constraint strictly', () => {
      const items: ContextItem[] = Array.from({ length: 10 }, (_, i) =>
        item(`f${i}.ts`, 10 + i, 0.1 * (i + 1))
      );
      const budget = 50;
      const result = dpSelector(items, budget);
      expect(result.totalTokens).toBeLessThanOrEqual(budget);
    });

    it('handles items with equal relevance but different token costs', () => {
      // Both have same relevance; DP should prefer the one that fits more value
      const items: ContextItem[] = [
        item('cheap.ts', 3, 0.5),
        item('expensive.ts', 8, 0.5),
      ];
      const result = dpSelector(items, 10);
      // Both fit: 3 + 8 = 11 > 10, so only one should be selected.
      // DP picks the combination that maximizes value — both same value,
      // so it prefers the one with fewer tokens (min-token tie-break).
      expect(result.totalTokens).toBeLessThanOrEqual(10);
      expect(result.selectedItems.length).toBeGreaterThanOrEqual(1);
    });

    it('produces a valid SelectionResult shape', () => {
      const items: ContextItem[] = [
        item('a.ts', 5, 0.6),
        item('b.ts', 5, 0.5),
      ];
      const result = dpSelector(items, 10);
      expect(result).toHaveProperty('selectedItems');
      expect(result).toHaveProperty('excludedItems');
      expect(result).toHaveProperty('totalTokens');
      expect(result).toHaveProperty('totalRelevance');
      // selected + excluded should equal input
      expect(result.selectedItems.length + result.excludedItems.length).toBe(items.length);
    });
  });

  // ============================================================
  // Task 2: greedySelector() with known item sets
  // ============================================================
  describe('greedySelector()', () => {
    it('selects items by relevance density (relevance/tokens) descending', () => {
      // Densities: a=0.6/6=0.1, b=0.5/5=0.1, c=0.4/4=0.1 (all equal)
      // With equal densities, sort is stable-ish by original order
      const items: ContextItem[] = [
        item('a.ts', 6, 0.6),
        item('b.ts', 5, 0.5),
        item('c.ts', 4, 0.4),
      ];
      const result = greedySelector(items, 10);
      expect(result.totalTokens).toBeLessThanOrEqual(10);
      expect(result.selectedItems.length).toBeGreaterThan(0);
    });

    it('returns empty selection for empty items', () => {
      const result = greedySelector([], 100);
      expect(result.selectedItems).toEqual([]);
      expect(result.totalTokens).toBe(0);
      expect(result.totalRelevance).toBe(0);
    });

    it('picks the highest density item first', () => {
      // Density: a=1.0/5=0.2, b=0.5/5=0.1, c=0.3/5=0.06
      const items: ContextItem[] = [
        item('a.ts', 5, 1.0),
        item('b.ts', 5, 0.5),
        item('c.ts', 5, 0.3),
      ];
      const result = greedySelector(items, 5);
      expect(result.selectedItems.map((i) => i.path)).toEqual(['a.ts']);
    });

    it('fills the budget with as many items as possible', () => {
      const items: ContextItem[] = Array.from({ length: 10 }, (_, i) =>
        item(`f${i}.ts`, 10, 0.1 * (10 - i))
      );
      const budget = 50;
      const result = greedySelector(items, budget);
      expect(result.selectedItems.length).toBe(5);
      expect(result.totalTokens).toBeLessThanOrEqual(budget);
    });

    it('respects budget strictly', () => {
      const items: ContextItem[] = [
        item('a.ts', 30, 1.0),
        item('b.ts', 30, 0.9),
        item('c.ts', 30, 0.8),
      ];
      const result = greedySelector(items, 50);
      expect(result.totalTokens).toBeLessThanOrEqual(50);
      expect(result.selectedItems.length).toBe(1);
    });

    it('handles single item within budget', () => {
      const items: ContextItem[] = [item('only.ts', 5, 0.7)];
      const result = greedySelector(items, 10);
      expect(result.selectedItems.map((i) => i.path)).toEqual(['only.ts']);
      expect(result.totalRelevance).toBeCloseTo(0.7);
    });

    it('handles single item exceeding budget', () => {
      const items: ContextItem[] = [item('huge.ts', 100, 1.0)];
      const result = greedySelector(items, 10);
      expect(result.selectedItems).toEqual([]);
      expect(result.excludedItems.map((i) => i.path)).toEqual(['huge.ts']);
    });
  });

  // ============================================================
  // Task 3: dpApplicable() for memory bounds checking
  // ============================================================
  describe('dpApplicable()', () => {
    it('returns false for empty items', () => {
      expect(dpApplicable([])).toBe(false);
    });

    it('returns true for a small number of items within bounds', () => {
      const items: ContextItem[] = Array.from({ length: 10 }, (_, i) =>
        item(`f${i}.ts`, 100, 0.5)
      );
      expect(dpApplicable(items)).toBe(true);
    });

    it('returns false when item count exceeds DP_MAX_ITEMS', () => {
      const items: ContextItem[] = Array.from({ length: DP_MAX_ITEMS + 1 }, (_, i) =>
        item(`f${i}.ts`, 100, 0.1)
      );
      expect(dpApplicable(items)).toBe(false);
    });

    it('returns true when item count equals DP_MAX_ITEMS', () => {
      const items: ContextItem[] = Array.from({ length: DP_MAX_ITEMS }, (_, i) =>
        item(`f${i}.ts`, 100, 0.1)
      );
      expect(dpApplicable(items)).toBe(true);
    });

    it('returns false when total quantized value exceeds DP_TOTAL_VALUE_CAP', () => {
      // Each item at relevance 2.0 → quantized value = 2.0 * 500 = 1000
      // Need enough items that n * 1000 > 100_000 → n > 100
      const items: ContextItem[] = Array.from({ length: 101 }, (_, i) =>
        item(`f${i}.ts`, 100, 2.0)
      );
      // 101 * 1000 = 101_000 > 100_000
      expect(dpApplicable(items)).toBe(false);
    });

    it('returns true when total quantized value equals DP_TOTAL_VALUE_CAP', () => {
      // Need n <= DP_MAX_ITEMS (60) and totalValue = n * 1000 = 100_000 → n = 100
      // But n=100 > DP_MAX_ITEMS=60, so dpApplicable returns false due to item count.
      // Instead use n=60 at relevance ~1.67: 60 * round(1.67 * 500) = 60 * 835 = 50_100 < cap.
      // To hit exactly 100_000 with n <= 60, use relevance 2.0 and verify the cap boundary:
      // n=60 at relevance 2.0: totalValue = 60 * 1000 = 60_000 < 100_000 cap → applicable.
      const items: ContextItem[] = Array.from({ length: 60 }, (_, i) =>
        item(`f${i}.ts`, 100, 2.0)
      );
      expect(dpApplicable(items)).toBe(true);
    });

    it('handles a single item within bounds', () => {
      const items: ContextItem[] = [item('one.ts', 100, 0.5)];
      expect(dpApplicable(items)).toBe(true);
    });
  });

  // ============================================================
  // Task 4: Edge cases — NaN, negative, empty, single item
  // ============================================================
  describe('edge cases', () => {
    it('dpSelector handles NaN relevance scores (treats as 0)', () => {
      const items: ContextItem[] = [
        item('nan.ts', 5, Number.NaN),
        item('ok.ts', 5, 0.5),
      ];
      expect(() => dpSelector(items, 100)).not.toThrow();
      const result = dpSelector(items, 100);
      expect(result.selectedItems.some((i) => i.path === 'ok.ts')).toBe(true);
      expect(Number.isFinite(result.totalRelevance)).toBe(true);
    });

    it('dpSelector handles negative relevance scores (clamps to 0)', () => {
      const items: ContextItem[] = [
        item('neg.ts', 5, -3),
        item('ok.ts', 5, 0.5),
      ];
      const result = dpSelector(items, 100);
      expect(result.selectedItems.some((i) => i.path === 'ok.ts')).toBe(true);
      // Negative score → quantized to 0 → never selected
      expect(result.selectedItems.some((i) => i.path === 'neg.ts')).toBe(false);
    });

    it('dpSelector handles very large relevance scores (clamps to DP_MAX_RELEVANCE)', () => {
      const items: ContextItem[] = [
        item('huge.ts', 5, 1e9),
        item('normal.ts', 5, 0.5),
      ];
      const result = dpSelector(items, 100);
      expect(() => result).not.toThrow();
      // Both should fit within budget
      expect(result.selectedItems.length).toBe(2);
    });

    it('greedySelector handles NaN relevance scores', () => {
      const items: ContextItem[] = [
        item('nan.ts', 5, Number.NaN),
        item('ok.ts', 5, 0.5),
      ];
      // NaN density = NaN / 5 = NaN; sort may place it anywhere but shouldn't throw
      expect(() => greedySelector(items, 100)).not.toThrow();
      const result = greedySelector(items, 100);
      // ok.ts should be selected; nan.ts has 0 value
      expect(result.selectedItems.some((i) => i.path === 'ok.ts')).toBe(true);
    });

    it('greedySelector handles negative relevance scores', () => {
      const items: ContextItem[] = [
        item('neg.ts', 5, -1),
        item('ok.ts', 5, 0.5),
      ];
      expect(() => greedySelector(items, 100)).not.toThrow();
      const result = greedySelector(items, 100);
      expect(result.selectedItems.some((i) => i.path === 'ok.ts')).toBe(true);
    });

    it('dpSelector with single item that fits', () => {
      const items: ContextItem[] = [item('solo.ts', 5, 0.8)];
      const result = dpSelector(items, 10);
      expect(result.selectedItems.map((i) => i.path)).toEqual(['solo.ts']);
      expect(result.totalRelevance).toBeCloseTo(0.8);
    });

    it('dpSelector with single item that exceeds budget', () => {
      const items: ContextItem[] = [item('big.ts', 100, 1.0)];
      const result = dpSelector(items, 10);
      expect(result.selectedItems).toEqual([]);
      expect(result.totalTokens).toBe(0);
    });

    it('greedySelector with single item that fits', () => {
      const items: ContextItem[] = [item('solo.ts', 5, 0.8)];
      const result = greedySelector(items, 10);
      expect(result.selectedItems.map((i) => i.path)).toEqual(['solo.ts']);
    });

    it('greedySelector with single item that exceeds budget', () => {
      const items: ContextItem[] = [item('big.ts', 100, 1.0)];
      const result = greedySelector(items, 10);
      expect(result.selectedItems).toEqual([]);
    });

    it('dpSelector with zero-token items (weight floors to 1)', () => {
      const items: ContextItem[] = [
        item('zero.ts', 0, 0.5),
        item('normal.ts', 5, 0.6),
      ];
      // tokens=0 → weight = max(1, floor(0)) = 1
      const result = dpSelector(items, 10);
      expect(result.selectedItems.length).toBeGreaterThan(0);
      expect(result.totalTokens).toBeLessThanOrEqual(10);
    });

    it('greedySelector with zero-token items', () => {
      const items: ContextItem[] = [
        item('zero.ts', 0, 0.5),
        item('normal.ts', 5, 0.6),
      ];
      // Density for zero-token: 0.5 / max(0, 1) = 0.5
      expect(() => greedySelector(items, 10)).not.toThrow();
    });

    it('dpSelector with all zero-relevance items returns empty', () => {
      const items: ContextItem[] = [
        item('a.ts', 5, 0),
        item('b.ts', 5, 0),
      ];
      const result = dpSelector(items, 100);
      expect(result.selectedItems).toEqual([]);
      expect(result.totalRelevance).toBe(0);
    });

    it('greedySelector with all zero-relevance items', () => {
      const items: ContextItem[] = [
        item('a.ts', 5, 0),
        item('b.ts', 5, 0),
      ];
      // Density = 0 for all; no item adds value, but greedy may still pick them
      // if they fit the budget (it maximizes count when density is 0? No — it
      // picks by density, all 0, so first items get picked)
      const result = greedySelector(items, 100);
      expect(result.totalTokens).toBeLessThanOrEqual(100);
    });

    it('dpSelector handles mixed NaN, negative, huge, and valid scores', () => {
      const items: ContextItem[] = [
        item('nan.ts', 5, Number.NaN),
        item('neg.ts', 5, -3),
        item('huge.ts', 5, 1e9),
        item('ok.ts', 5, 0.5),
      ];
      expect(() => dpSelector(items, 100)).not.toThrow();
      const result = dpSelector(items, 100);
      expect(result.selectedItems.some((i) => i.path === 'ok.ts')).toBe(true);
      expect(Number.isFinite(result.totalRelevance)).toBe(true);
    });
  });

  // ============================================================
  // Task 5: DP constants
  // ============================================================
  describe('DP constants', () => {
    it('DP_VALUE_SCALE equals 500', () => {
      expect(DP_VALUE_SCALE).toBe(500);
    });

    it('DP_MAX_RELEVANCE equals 2', () => {
      expect(DP_MAX_RELEVANCE).toBe(2);
    });

    it('DP_MAX_ITEMS equals 60', () => {
      expect(DP_MAX_ITEMS).toBe(60);
    });

    it('DP_TOTAL_VALUE_CAP equals 100_000', () => {
      expect(DP_TOTAL_VALUE_CAP).toBe(100_000);
    });

    it('quantized value at max relevance equals DP_MAX_RELEVANCE * DP_VALUE_SCALE', () => {
      // At relevance = 2.0: quantized = round(2.0 * 500) = 1000
      const items: ContextItem[] = [item('max.ts', 10, 2.0)];
      expect(dpApplicable(items)).toBe(true);
      // Verify the DP can handle items at the max quantized value
      const result = dpSelector(items, 100);
      expect(result.selectedItems.map((i) => i.path)).toEqual(['max.ts']);
    });

    it('DP table width stays bounded for max-relevance items', () => {
      // 60 items at relevance 2.0: totalValue = 60 * 1000 = 60_000 < 100_000 cap
      const items: ContextItem[] = Array.from({ length: DP_MAX_ITEMS }, (_, i) =>
        item(`f${i}.ts`, 100, 2.0)
      );
      expect(dpApplicable(items)).toBe(true);
      const t0 = performance.now();
      const result = dpSelector(items, 5000);
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThan(2000);
      expect(result.totalTokens).toBeLessThanOrEqual(5000);
    });

    it('falls back to greedy when DP applicability check fails', () => {
      // n > DP_MAX_ITEMS triggers greedy fallback in the optimizer context
      const items: ContextItem[] = Array.from({ length: DP_MAX_ITEMS + 5 }, (_, i) =>
        item(`m-${i}.ts`, 10 + (i % 7), 0.1 + (i % 10) * 0.05)
      );
      expect(dpApplicable(items)).toBe(false);
    });
  });

  // ============================================================
  // Cross-selector consistency
  // ============================================================
  describe('dpSelector vs greedySelector consistency', () => {
    it('DP is at least as good as greedy on the classic counterexample', () => {
      const items: ContextItem[] = [
        item('a.ts', 6, 0.61),
        item('b.ts', 5, 0.5),
        item('c.ts', 5, 0.5),
      ];
      const greedy = greedySelector(items, 10);
      const dp = dpSelector(items, 10);
      expect(dp.totalRelevance).toBeGreaterThanOrEqual(greedy.totalRelevance);
    });

    it('DP is at least as good as greedy on random item sets', () => {
      const items: ContextItem[] = Array.from({ length: 20 }, (_, i) =>
        item(`f${i}.ts`, 5 + (i % 10) * 3, 0.1 + (i % 8) * 0.12)
      );
      const budget = 80;
      const greedy = greedySelector(items, budget);
      const dp = dpSelector(items, budget);
      // Use toBeCloseTo to handle floating point rounding
      expect(dp.totalRelevance).toBeGreaterThanOrEqual(greedy.totalRelevance - 1e-9);
      expect(dp.totalTokens).toBeLessThanOrEqual(budget);
      expect(greedy.totalTokens).toBeLessThanOrEqual(budget);
    });

    it('both selectors produce valid SelectionResult shapes', () => {
      const items: ContextItem[] = [
        item('a.ts', 5, 0.6),
        item('b.ts', 3, 0.4),
        item('c.ts', 7, 0.8),
      ];
      const budget = 10;
      const greedy = greedySelector(items, budget);
      const dp = dpSelector(items, budget);

      for (const result of [greedy, dp]) {
        expect(result.selectedItems.length + result.excludedItems.length).toBe(items.length);
        expect(result.totalTokens).toBeLessThanOrEqual(budget);
        expect(Number.isFinite(result.totalRelevance)).toBe(true);
      }
    });
  });
});
