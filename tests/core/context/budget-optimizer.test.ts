import { describe, it, expect } from 'vitest';
import { ContextBudgetOptimizer } from '../../../src/core/context/budget-optimizer.js';
import type { ContextItem } from '../../../src/core/context/types.js';

describe('ContextBudgetOptimizer', () => {
  it('returns empty selection for empty item list', () => {
    const opt = new ContextBudgetOptimizer();
    const result = opt.optimize([], 100);
    expect(result.selectedItems).toEqual([]);
    expect(result.totalTokens).toBe(0);
  });

  it('selects single item under budget', () => {
    const opt = new ContextBudgetOptimizer();
    const items: ContextItem[] = [{ path: 'a.ts', tokens: 10, relevanceScore: 5 }];
    const result = opt.optimize(items, 100);
    expect(result.selectedItems).toHaveLength(1);
    expect(result.selectedItems[0].path).toBe('a.ts');
  });

  it('partially selects when items exceed budget', () => {
    const opt = new ContextBudgetOptimizer();
    const items: ContextItem[] = [
      { path: 'a.ts', tokens: 60, relevanceScore: 10 },
      { path: 'b.ts', tokens: 60, relevanceScore: 10 },
    ];
    const result = opt.optimize(items, 100);
    expect(result.selectedItems.length).toBe(1);
    expect(result.totalTokens).toBeLessThanOrEqual(100);
  });

  it('breaks ties by relevance score (higher first)', () => {
    const opt = new ContextBudgetOptimizer();
    const items: ContextItem[] = [
      { path: 'low.ts', tokens: 10, relevanceScore: 1 },
      { path: 'high.ts', tokens: 10, relevanceScore: 10 },
    ];
    const result = opt.optimize(items, 10);
    expect(result.selectedItems[0].path).toBe('high.ts');
  });

  it('throws on invalid tokens (0)', () => {
    const opt = new ContextBudgetOptimizer();
    expect(() => opt.optimize([{ path: 'bad.ts', tokens: 0, relevanceScore: 1 }], 10)).toThrow();
  });

  it('throws on invalid budget (-1)', () => {
    const opt = new ContextBudgetOptimizer();
    expect(() => opt.optimize([{ path: 'a.ts', tokens: 1, relevanceScore: 1 }], -1)).toThrow();
  });

  it('allows strategy change', () => {
    const opt = new ContextBudgetOptimizer();
    opt.setStrategy('adaptive');
    const result = opt.optimize([{ path: 'a.ts', tokens: 5, relevanceScore: 2 }], 10);
    expect(result.selectedItems.length).toBe(1);
  });
});
