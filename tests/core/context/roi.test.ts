import { describe, expect, it } from 'vitest';
import { ContextBudgetOptimizer, createFullFilePlan } from '@/core/context/budget-optimizer.js';
import { calculateContextRoi, compareContextPlans } from '@/core/context/roi.js';
import { assessContextPricing } from '@/core/context/pricing.js';
import type { ContextItem } from '@/core/context/types.js';

describe('calculateContextRoi', () => {
  it('reports selection savings and original-score relevance coverage', () => {
    const items: ContextItem[] = [
      { path: 'src/auth.ts', tokens: 10, relevanceScore: 0.9 },
      { path: 'src/session.ts', tokens: 20, relevanceScore: 0.4 },
      { path: 'src/types.ts', tokens: 5, relevanceScore: 0.1 },
    ];
    const plan = new ContextBudgetOptimizer().optimize(items, 15);

    const roi = calculateContextRoi(items, plan);

    expect(roi.status).toBe('estimated');
    expect(roi.candidateFiles).toBe(3);
    expect(roi.selectedFiles).toBe(2);
    expect(roi.excludedFiles).toBe(1);
    expect(roi.candidateTokens).toBe(35);
    expect(roi.allocatedTokens).toBe(15);
    expect(roi.estimatedSavedTokens).toBe(20);
    expect(roi.estimatedSavedPercent).toBe(57.14);
    expect(roi.relevanceCoverage).toBe(0.7143);
    expect(roi.limitations.length).toBeGreaterThan(0);
  });

  it('does not count task-type score boosts as extra candidate relevance', () => {
    const items: ContextItem[] = [
      { path: 'src/api.ts', tokens: 10, relevanceScore: 0.5, apiSurface: true },
      { path: 'src/other.ts', tokens: 10, relevanceScore: 0.5 },
    ];
    const optimizer = new ContextBudgetOptimizer({ taskType: 'feature' });
    const plan = optimizer.optimize(items, 10, 'feature');

    const roi = calculateContextRoi(items, plan);

    expect(plan.selectedItems[0]?.relevanceScore).toBeGreaterThan(0.5);
    expect(roi.relevanceCoverage).toBe(0.5);
  });

  it('reports exact byte arithmetic only when every candidate has measured bytes', () => {
    const items: ContextItem[] = [
      { path: 'src/a.ts', tokens: 10, bytes: 40, relevanceScore: 1 },
      { path: 'src/b.ts', tokens: 10, bytes: 60, relevanceScore: 0.5 },
    ];
    const plan = new ContextBudgetOptimizer().optimize(items, 10);
    const roi = calculateContextRoi(items, plan);

    expect(roi).toMatchObject({
      candidateBytes: 100,
      allocatedBytes: 40,
      estimatedSavedBytes: 60,
      estimatedSavedBytesPercent: 60,
    });
    expect(roi.limitations).not.toContain(
      'Exact source bytes were not supplied for every candidate; byte savings are unavailable.',
    );
  });

  it('does not invent byte savings when a candidate byte size is absent', () => {
    const items: ContextItem[] = [
      { path: 'src/a.ts', tokens: 10, bytes: 40, relevanceScore: 1 },
      { path: 'src/b.ts', tokens: 10, relevanceScore: 0.5 },
    ];
    const plan = new ContextBudgetOptimizer().optimize(items, 10);
    const roi = calculateContextRoi(items, plan);

    expect(roi.candidateBytes).toBeNull();
    expect(roi.estimatedSavedBytes).toBeNull();
    expect(roi.limitations).toContain(
      'Exact source bytes were not supplied for every candidate; byte savings are unavailable.',
    );
  });

  it('computes reproducible local cost estimates only when a price is supplied', () => {
    const items: ContextItem[] = [
      { path: 'src/a.ts', tokens: 100, bytes: 400, relevanceScore: 1 },
      { path: 'src/b.ts', tokens: 300, bytes: 1200, relevanceScore: 0.5 },
    ];
    const plan = new ContextBudgetOptimizer().optimize(items, 100);
    const priced = calculateContextRoi(items, plan, { inputPricePer1k: 0.5 });
    expect(priced.tokenMeasurement).toBe('estimated-char-div-4');
    expect(priced.tokenAccounting).toBe('estimated-utf8-byte-div-4');
    expect(priced.candidateCostUsd).toBe(0.2);
    expect(priced.allocatedCostUsd).toBe(0.05);
    expect(priced.estimatedSavedCostUsd).toBe(0.15);

    const unpriced = calculateContextRoi(items, plan);
    expect(unpriced.candidateCostUsd).toBeNull();
    expect(unpriced.estimatedSavedCostUsd).toBeNull();
    expect(unpriced.limitations.join(' ')).toContain('Input price was not supplied');
    expect(priced.pricingStatus).toBe('unverified');
  });

  it('uses a current auditable price record and fails closed for stale records', () => {
    const now = Date.parse('2026-09-11T12:00:00Z');
    const items: ContextItem[] = [{ path: 'src/a.ts', tokens: 100, bytes: 400, relevanceScore: 1 }];
    const plan = new ContextBudgetOptimizer().optimize(items, 50);
    const current = calculateContextRoi(items, plan, {
      pricing: {
        inputPricePer1k: 0.5,
        outputPricePer1k: 1.5,
        currency: 'USD',
        source: 'https://provider.example/pricing',
        effectiveAt: '2026-01-01T00:00:00Z',
        expiresAt: '2027-01-01T00:00:00Z',
      },
    });
    expect(current.pricingStatus).toBe('current');
    expect(current.pricingSource).toBe('https://provider.example/pricing');
    expect(current.outputPricePer1k).toBe(1.5);

    const expired = assessContextPricing(
      {
        inputPricePer1k: 0.5,
        source: 'https://provider.example/pricing',
        effectiveAt: '2025-01-01T00:00:00Z',
        expiresAt: '2026-01-01T00:00:00Z',
      },
      now,
    );
    expect(expired).toMatchObject({ status: 'expired', inputPricePer1k: null });
  });

  it('rejects future prices from cost arithmetic', () => {
    const result = assessContextPricing(
      {
        inputPricePer1k: 0.5,
        source: 'provider',
        effectiveAt: '2027-01-01T00:00:00Z',
      },
      Date.parse('2026-09-11T12:00:00Z'),
    );
    expect(result.status).toBe('not-yet-effective');
    expect(result.inputPricePer1k).toBeNull();
  });

  it('compares produced plans and keeps unavailable retrieval modes explicit', () => {
    const items: ContextItem[] = [
      { path: 'src/a.ts', tokens: 10, bytes: 40, relevanceScore: 1 },
      { path: 'src/b.ts', tokens: 20, bytes: 80, relevanceScore: 0.5 },
    ];
    const plan = new ContextBudgetOptimizer().optimize(items, 10);
    const comparisons = compareContextPlans(items, [
      { variant: 'budgeted-file', plan },
      {
        variant: 'byte-range',
        limitations: ['No source range was supplied.'],
      },
      { variant: 'budgeted-file', plan: undefined },
    ]);

    expect(comparisons).toHaveLength(2);
    expect(comparisons[0]?.available).toBe(true);
    expect(comparisons[0]?.roi?.allocatedTokens).toBe(10);
    expect(comparisons[1]).toMatchObject({ variant: 'byte-range', available: false, roi: null });
    expect(comparisons[1]?.limitations.join(' ')).toContain('No source range');
    expect(comparisons[1]?.limitations.join(' ')).toContain('no token');
  });

  it('keeps zero-relevance candidates in the full-file ROI baseline', () => {
    const items: ContextItem[] = [
      { path: 'src/used.ts', tokens: 10, bytes: 40, relevanceScore: 1 },
      { path: 'src/unknown.ts', tokens: 20, bytes: 80, relevanceScore: 0 },
    ];
    const baseline = createFullFilePlan(items);
    const roi = calculateContextRoi(items, baseline);
    expect(baseline.files).toHaveLength(2);
    expect(baseline.excludedFiles).toHaveLength(0);
    expect(roi.candidateTokens).toBe(30);
    expect(roi.allocatedTokens).toBe(30);
    expect(roi.relevanceCoverage).toBe(1);
  });
});
