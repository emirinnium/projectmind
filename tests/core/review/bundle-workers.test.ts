import { describe, expect, it } from 'vitest';
import { executeReviewBundles } from '../../../src/core/review/bundle-workers.js';
import type { ReviewBundle } from '../../../src/core/review/bundle.js';

function bundles(count: number): ReviewBundle[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `bundle-${index + 1}`,
    inputHash: `hash-${index + 1}`,
    files: [],
    estimatedBytes: 1,
    estimatedTokens: 1,
    oversized: false,
  }));
}

describe('review bundle workers', () => {
  it('returns canonical bundle order despite different completion times', async () => {
    const result = await executeReviewBundles(
      bundles(3),
      async ({ bundle }) => {
        await new Promise((resolve) => setTimeout(resolve, bundle.id === 'bundle-1' ? 15 : 1));
        return bundle.id;
      },
      { concurrency: 2, timeoutMs: 100, maxRetries: 0 },
    );

    expect(result.complete).toBe(true);
    expect(result.results.map((entry) => entry.value)).toEqual([
      'bundle-1',
      'bundle-2',
      'bundle-3',
    ]);
  });

  it('retries a failed bundle and records the successful attempt', async () => {
    let calls = 0;
    const result = await executeReviewBundles(
      bundles(1),
      () => {
        calls++;
        if (calls === 1) throw new Error('transient provider failure');
        return 'ok';
      },
      { timeoutMs: 100, maxRetries: 1 },
    );

    expect(result.results[0]).toMatchObject({ status: 'completed', attempts: 2, value: 'ok' });
  });

  it('marks a non-cooperative slow worker as timed out after retries', async () => {
    const result = await executeReviewBundles(
      bundles(1),
      () => new Promise((resolve) => setTimeout(() => resolve('late'), 30)),
      { timeoutMs: 5, maxRetries: 1 },
    );

    expect(result.complete).toBe(false);
    expect(result.timedOut).toBe(1);
    expect(result.results[0]?.error?.code).toBe('review.bundle-timeout');
    expect(result.results[0]?.attempts).toBe(2);
  });

  it('rejects unsafe worker limits', async () => {
    await expect(executeReviewBundles(bundles(1), () => 'ok', { concurrency: 0 })).rejects.toThrow(
      /between 1 and 32/,
    );
    await expect(executeReviewBundles(bundles(1), () => 'ok', { maxRetries: 6 })).rejects.toThrow(
      /between 0 and 5/,
    );
  });
});
