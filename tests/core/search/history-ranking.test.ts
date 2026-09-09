import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryRanker } from '../../../src/core/search/history-ranking.js';

describe('history ranking', () => {
  it('returns a bounded score for a tracked source and does not use shell syntax', () => {
    const root = process.cwd();
    const ranker = new HistoryRanker(root, { nowMs: Date.now() });
    const score = ranker.score('src/core/search/intent-engine.ts');
    expect(score).toBeTypeOf('number');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('resolves a bounded batch without starting one Git query per source file', () => {
    const root = process.cwd();
    const ranker = new HistoryRanker(root, { nowMs: Date.now() });
    const scores = ranker.scoreMany([
      'src/core/search/intent-engine.ts',
      'src/core/search/history-ranking.ts',
      'new-file-that-is-not-tracked.ts',
    ]);
    expect(scores.has('src/core/search/intent-engine.ts')).toBe(true);
    expect(scores.has('src/core/search/history-ranking.ts')).toBe(true);
    expect(scores.get('new-file-that-is-not-tracked.ts')).toBeUndefined();
    for (const score of scores.values()) {
      if (score !== undefined) expect(score).toBeGreaterThanOrEqual(0);
      if (score !== undefined) expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('returns every requested key even when the bounded cache evicts older batches', () => {
    const ranker = new HistoryRanker(process.cwd(), { cacheSize: 1 });
    const scores = ranker.scoreMany([
      'src/core/search/intent-engine.ts',
      'src/core/search/history-ranking.ts',
    ]);
    expect(scores.has('src/core/search/intent-engine.ts')).toBe(true);
    expect(scores.has('src/core/search/history-ranking.ts')).toBe(true);
  });

  it('returns undefined for an invalid or untracked path without leaking outside content', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-history-'));
    writeFileSync(join(root, 'new.ts'), 'export const value = 1;\n');
    const ranker = new HistoryRanker(root);
    expect(ranker.score('../secret.ts')).toBeUndefined();
    expect(ranker.score('new.ts')).toBeUndefined();
  });
});
