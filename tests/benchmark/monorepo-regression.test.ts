import { describe, expect, it } from 'vitest';
import { evaluateMonorepoRegression } from '../../scripts/benchmark/check-monorepo-regression.mjs';

const baseline = {
  evaluatorName: 'projectmind-monorepo-boundary',
  fixture: {
    fileCount: 240,
    packageCount: 12,
    inputHash: 'fixture-hash',
  },
  full: { totalFiles: 240, scannedFiles: 240, errorFiles: 0 },
  incremental: { totalFiles: 240, scannedFiles: 0, errorFiles: 0 },
  requirePassed: true,
};

const current = {
  evaluator: { name: 'projectmind-monorepo-boundary' },
  fixture: { fileCount: 240, packageCount: 12, inputHash: 'fixture-hash' },
  full: { totalFiles: 240, scannedFiles: 240, errorFiles: 0, durationMs: 10 },
  incremental: { totalFiles: 240, scannedFiles: 0, errorFiles: 0, durationMs: 2 },
  passed: true,
};

describe('monorepo benchmark regression gate', () => {
  it('ignores hardware-dependent durations but enforces completeness identity', () => {
    expect(evaluateMonorepoRegression(current, baseline)).toEqual({
      passed: true,
      failures: [],
    });
  });

  it('fails closed on fixture drift and scan errors', () => {
    const result = evaluateMonorepoRegression(
      {
        ...current,
        fixture: { ...current.fixture, inputHash: 'changed' },
        full: { ...current.full, errorFiles: 1 },
      },
      baseline,
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'Fixture inputHash changed from fixture-hash to changed.',
        'full.errorFiles changed from 0 to 1.',
      ]),
    );
  });
});
