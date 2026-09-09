import { describe, expect, it } from 'vitest';
import { selectCanonicalExample } from '../../../src/core/search/canonical-example.js';

const hash = (digit: string): string => digit.repeat(64);

describe('canonical example selection', () => {
  it('selects deterministically and exposes evidence instead of a bare score', () => {
    const result = selectCanonicalExample([
      {
        path: 'src/unstable.ts',
        sourceHash: hash('a'),
        relevanceScore: 0.9,
        historyScore: 0.2,
        testScore: 0.2,
        coherenceScore: 0.3,
      },
      {
        path: 'src/stable.ts',
        sourceHash: hash('b'),
        relevanceScore: 0.8,
        historyScore: 0.9,
        graphScore: 0.8,
        testScore: 0.9,
        coherenceScore: 0.9,
        freshnessScore: 0.9,
      },
    ]);
    expect(result.selected?.path).toBe('src/stable.ts');
    expect(result.selected?.scoreBreakdown).toHaveProperty('history');
    expect(result.selected?.reasons.length).toBeGreaterThan(1);
    expect(result.nextAction).toContain('source hash');
  });

  it('uses a neutral prior for omitted signals and rejects invalid hashes', () => {
    const result = selectCanonicalExample([
      { path: 'bad.ts', sourceHash: 'not-a-hash' },
      { path: 'new.ts', sourceHash: hash('c') },
    ]);
    expect(result.considered).toBe(1);
    expect(result.selected?.path).toBe('new.ts');
    expect(result.selected?.score).toBeGreaterThan(0);
  });
});
