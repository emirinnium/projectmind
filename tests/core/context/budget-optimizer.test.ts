import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextBudgetOptimizer,
  applyTaskTypeBoosts,
} from '../../../src/core/context/budget-optimizer.js';
import {
  greedySelector,
  dpSelector,
  dpApplicable,
  DP_MAX_ITEMS,
} from '../../../src/core/context/knapsack.js';
import type { ContextItem } from '../../../src/core/context/types.js';

describe('ContextBudgetOptimizer', () => {
  // (a) DP optimality: hand-computed case where greedy provably loses.
  // Budget 10; densities: A=0.61/6=0.1017, B=C=0.5/5=0.1.
  // Greedy takes A (6 tokens), then B/C don't fit -> total 0.61.
  // DP takes B+C (10 tokens) -> total 1.0 (optimal).
  it('DP returns the optimal set where greedy loses', () => {
    const items: ContextItem[] = [
      { path: 'a.ts', tokens: 6, relevanceScore: 0.61 },
      { path: 'b.ts', tokens: 5, relevanceScore: 0.5 },
      { path: 'c.ts', tokens: 5, relevanceScore: 0.5 },
    ];

    const greedy = greedySelector(items, 10);
    expect(greedy.selectedItems.map((i) => i.path)).toEqual(['a.ts']);
    expect(greedy.totalRelevance).toBeCloseTo(0.61);

    const dp = dpSelector(items, 10);
    expect(dp.selectedItems.map((i) => i.path).sort()).toEqual(['b.ts', 'c.ts']);
    expect(dp.totalRelevance).toBeCloseTo(1.0);
    expect(dp.totalTokens).toBeLessThanOrEqual(10);
  });

  it('DP is at least as good as greedy (plan example shape)', () => {
    const items: ContextItem[] = [
      { path: 'a.ts', tokens: 6, relevanceScore: 0.6 },
      { path: 'b.ts', tokens: 5, relevanceScore: 0.5 },
      { path: 'c.ts', tokens: 4, relevanceScore: 0.4 },
    ];
    const dp = dpSelector(items, 10);
    const greedy = greedySelector(items, 10);
    expect(dp.totalRelevance).toBeGreaterThanOrEqual(greedy.totalRelevance);
    expect(dp.totalTokens).toBeLessThanOrEqual(10);
    // Optimum here is a+c = 1.0
    expect(dp.totalRelevance).toBeCloseTo(1.0);
  });

  // (b) large-budget smoke: n=15, budget=200000 completes fast, no OOM.
  it('handles budget=200000 with n=15 quickly (memory-safe DP)', () => {
    const items: ContextItem[] = Array.from({ length: 15 }, (_, i) => ({
      path: `file-${i}.ts`,
      tokens: 1000 + i * 1234,
      relevanceScore: 0.1 + (i % 9) * 0.1,
    }));
    const opt = new ContextBudgetOptimizer(); // default strategy = dp

    const t0 = performance.now();
    const plan = opt.optimize(items, 200_000);
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(1000);
    expect(plan.files.length).toBe(15); // everything fits
    expect(plan.allocatedTokens).toBeLessThanOrEqual(200_000);
  });

  // (c) plan shape: allocatedTokens == sum(files.tokens), reasons everywhere.
  it('produces the spec plan shape', () => {
    const items: ContextItem[] = [
      { path: 'in.ts', tokens: 30, relevanceScore: 0.9, semanticMatch: true },
      { path: 'out.ts', tokens: 90, relevanceScore: 0.1 },
    ];
    const opt = new ContextBudgetOptimizer();
    const plan = opt.optimize(items, 50);

    expect(plan.totalTokens).toBe(50);
    expect(plan.allocatedTokens).toBe(plan.files.reduce((s, f) => s + f.tokens, 0));
    expect(plan.files.map((f) => f.path)).toEqual(['in.ts']);
    for (const f of plan.files) {
      expect(f.inclusionReason.length).toBeGreaterThan(0);
      expect(f.relevanceScore).toBeGreaterThan(0);
    }
    expect(plan.excludedFiles.map((e) => e.path)).toEqual(['out.ts']);
    for (const e of plan.excludedFiles) {
      expect(e.reason.length).toBeGreaterThan(0);
    }
    expect(plan.compressionStrategy).toBeDefined();
  });

  it('derives inclusion reasons from metadata', () => {
    const items: ContextItem[] = [
      { path: 'sem.ts', tokens: 10, relevanceScore: 0.9, semanticMatch: true },
      { path: 'imp.ts', tokens: 10, relevanceScore: 0.8, importedByQueryFiles: true },
      { path: 'rec.ts', tokens: 10, relevanceScore: 0.7, recentlyChanged: true },
      { path: 'top.ts', tokens: 10, relevanceScore: 0.6 },
    ];
    const plan = new ContextBudgetOptimizer().optimize(items, 100);
    const reasons = new Map(plan.files.map((f) => [f.path, f.inclusionReason]));
    expect(reasons.get('sem.ts')).toBe('semantic match');
    expect(reasons.get('imp.ts')).toBe('import neighbor');
    expect(reasons.get('rec.ts')).toBe('recently changed');
    expect(reasons.get('top.ts')).toBe('top relevance');
  });

  // (d) task-type boost changes selection order.
  it('task-type boost changes selection for bug fix tasks', () => {
    // Y has a slightly higher base score, but X is recently changed.
    const x: ContextItem = { path: 'x.ts', tokens: 5, relevanceScore: 0.5, recentlyChanged: true };
    const y: ContextItem = { path: 'y.ts', tokens: 5, relevanceScore: 0.51 };

    const opt = new ContextBudgetOptimizer();
    const noTask = opt.optimize([x, y], 5);
    expect(noTask.files.map((f) => f.path)).toEqual(['y.ts']);

    const bugFix = opt.optimize([x, y], 5, 'bug fix');
    expect(bugFix.files.map((f) => f.path)).toEqual(['x.ts']);

    // Boosted items are new objects; caller items are not mutated.
    expect(x.relevanceScore).toBe(0.5);
    const boosted = applyTaskTypeBoosts([x], 'bug fix');
    expect(boosted[0].relevanceScore).toBeCloseTo(0.75);
    expect(boosted[0]).not.toBe(x);
  });

  it('test task type boosts test files', () => {
    const testFile: ContextItem = { path: 'a.test.ts', tokens: 5, relevanceScore: 0.5, isTestFile: true };
    const srcFile: ContextItem = { path: 'a.ts', tokens: 5, relevanceScore: 0.51 };
    const plan = new ContextBudgetOptimizer({ taskType: 'test' }).optimize([testFile, srcFile], 5);
    expect(plan.files.map((f) => f.path)).toEqual(['a.test.ts']);
    // File alone exceeds 20% of the budget, so a compression hint is appended.
    expect(plan.files[0].inclusionReason.startsWith('test file')).toBe(true);
  });

  // (e) token estimator char/4 sanity.
  describe('tokenEstimator', () => {
    let tmpDir: string;
    beforeAll(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'pm-budget-'));
    });
    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('estimates char/4 for real files', () => {
      const p = join(tmpDir, 'est.txt');
      writeFileSync(p, 'x'.repeat(400), 'utf-8');
      expect(ContextBudgetOptimizer.tokenEstimator(p)).toBe(100);
    });

    it('falls back to 100 for missing files', () => {
      expect(ContextBudgetOptimizer.tokenEstimator(join(tmpDir, 'nope.txt'))).toBe(100);
    });
  });

  // (f) greedy fallback path for large n, still respects budget.
  it('falls back to greedy when n exceeds DP bounds and respects budget', () => {
    const many: ContextItem[] = Array.from({ length: DP_MAX_ITEMS + 5 }, (_, i) => ({
      path: `m-${i}.ts`,
      tokens: 10 + (i % 7),
      relevanceScore: 0.1 + (i % 10) * 0.05,
    }));
    expect(dpApplicable(many)).toBe(false);
    expect(dpApplicable(many.slice(0, DP_MAX_ITEMS))).toBe(true);

    const plan = new ContextBudgetOptimizer().optimize(many, 100); // strategy 'dp' -> fallback
    expect(plan.allocatedTokens).toBeLessThanOrEqual(100);
    expect(plan.files.length).toBeGreaterThan(0);
    expect(plan.allocatedTokens).toBe(plan.files.reduce((s, f) => s + f.tokens, 0));
  });

  it('per-file compression hint for files dominating the budget', () => {
    const items: ContextItem[] = [
      { path: 'big.ts', tokens: 30, relevanceScore: 0.9 }, // > 20% of 100
      { path: 'small.ts', tokens: 10, relevanceScore: 0.8 },
    ];
    const plan = new ContextBudgetOptimizer().optimize(items, 100);
    const big = plan.files.find((f) => f.path === 'big.ts')!;
    const small = plan.files.find((f) => f.path === 'small.ts')!;
    expect(big.compressionStrategy).toBe('signature_only');
    expect(big.inclusionReason).toContain('signature_only');
    expect(small.compressionStrategy).toBeUndefined();
  });

  it('keeps greedy and adaptive strategies working', () => {
    const items: ContextItem[] = [
      { path: 'a.ts', tokens: 60, relevanceScore: 10 },
      { path: 'b.ts', tokens: 60, relevanceScore: 10 },
    ];
    const greedy = new ContextBudgetOptimizer({ strategy: 'greedy' }).optimize(items, 100);
    expect(greedy.files.length).toBe(1);

    const adaptive = new ContextBudgetOptimizer({ strategy: 'adaptive' }).optimize(items, 100);
    expect(adaptive.files.length).toBe(1);
    expect(adaptive.allocatedTokens).toBeLessThanOrEqual(100);
  });

  it('returns empty plan for empty input and validates arguments', () => {
    const opt = new ContextBudgetOptimizer();
    const empty = opt.optimize([], 100);
    expect(empty.files).toEqual([]);
    expect(empty.allocatedTokens).toBe(0);
    expect(empty.excludedFiles).toEqual([]);

    expect(() => opt.optimize([{ path: 'bad.ts', tokens: 0, relevanceScore: 1 }], 10)).toThrow();
    expect(() => opt.optimize([{ path: 'a.ts', tokens: 1, relevanceScore: 1 }], -1)).toThrow();
  });

  // (g) boost-ordering regression: the old [0,1] clamp quantized every
  // boosted (>1) score to the same value, so the DP's min-token tie-break
  // preferred the cheaper UNBOOSTED item. Clamp is now [0,2] (×500 scale).
  it('DP picks the boosted >1 item over an unboosted 1.0 item (no clamp collapse)', () => {
    // Boosted item: score 1.755 exactly as applyTaskTypeBoosts emits it
    // (0.9 * 1.5 recentlyChanged * 1.3 errorHandling). It costs MORE tokens,
    // so under the old clamp (both -> 1000) the min-token tie-break picked
    // the unboosted item. Budget fits exactly one item.
    const items: ContextItem[] = [
      { path: 'boosted.ts', tokens: 12, relevanceScore: 1.755 },
      { path: 'plain.ts', tokens: 10, relevanceScore: 1.0 },
    ];
    const dp = dpSelector(items, 12);
    expect(dp.selectedItems.map((i) => i.path)).toEqual(['boosted.ts']);
    expect(dp.totalTokens).toBeLessThanOrEqual(12);
  });

  it('end-to-end: task-type boost >1 beats a higher-base unboosted item', () => {
    const boosted: ContextItem = {
      path: 'boosted.ts',
      tokens: 12,
      relevanceScore: 0.9,
      recentlyChanged: true,
      errorHandling: true,
    };
    const plain: ContextItem = { path: 'plain.ts', tokens: 10, relevanceScore: 1.0 };

    // Sanity: the boost really pushes the score above 1.
    const afterBoost = applyTaskTypeBoosts([boosted], 'bug fix');
    expect(afterBoost[0].relevanceScore).toBeCloseTo(1.755);

    const plan = new ContextBudgetOptimizer().optimize([boosted, plain], 12, 'bug fix');
    expect(plan.files.map((f) => f.path)).toEqual(['boosted.ts']);
  });

  it('preserves ordering among distinct boosted scores (no quantization tie)', () => {
    // 1.95 and 1.3 must remain distinguishable after quantization.
    const items: ContextItem[] = [
      { path: 'hi.ts', tokens: 10, relevanceScore: 1.95 },
      { path: 'lo.ts', tokens: 10, relevanceScore: 1.3 },
    ];
    const dp = dpSelector(items, 10); // fits exactly one
    expect(dp.selectedItems.map((i) => i.path)).toEqual(['hi.ts']);
  });

  it('OOM-bound sanity: n=60 all at the 2.0 clamp completes within bounds', () => {
    const items: ContextItem[] = Array.from({ length: DP_MAX_ITEMS }, (_, i) => ({
      path: `f-${i}.ts`,
      tokens: 100 + i,
      relevanceScore: 2.0,
    }));
    expect(dpApplicable(items)).toBe(true);
    const t0 = performance.now();
    const dp = dpSelector(items, 3000);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(dp.totalTokens).toBeLessThanOrEqual(3000);
    expect(dp.selectedItems.length).toBeGreaterThan(0);
  });

  it('NaN / negative / huge scores are clamped safely (no OOM, no NaN leak)', () => {
    const items: ContextItem[] = [
      { path: 'nan.ts', tokens: 5, relevanceScore: Number.NaN },
      { path: 'neg.ts', tokens: 5, relevanceScore: -3 },
      { path: 'huge.ts', tokens: 5, relevanceScore: 1e9 },
      { path: 'ok.ts', tokens: 5, relevanceScore: 0.5 },
    ];
    expect(() => dpSelector(items, 100)).not.toThrow();
    const dp = dpSelector(items, 100);
    // NaN and negative contribute 0 value; huge is clamped to the cap.
    expect(dp.selectedItems.some((i) => i.path === 'ok.ts')).toBe(true);
    expect(Number.isFinite(dp.totalRelevance)).toBe(true);
  });
});
