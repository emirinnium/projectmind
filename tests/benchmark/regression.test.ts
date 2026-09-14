import { describe, expect, it } from 'vitest';
import { evaluateBenchmarkRegression } from '../../scripts/benchmark/regression.mjs';

const baseline = {
  manifestName: 'fixture-corpus',
  baselines: {
    lexical: {
      inputHash: 'fixture-hash',
      evaluatedCases: 2,
      aggregate: {
        precisionAtK: 0.8,
        recallAtK: 0.7,
        f1: 0.75,
        mrr: 0.9,
        ndcg: 0.85,
      },
    },
  },
};

function result(overrides: Record<string, unknown> = {}) {
  return {
    manifest: { name: 'fixture-corpus', inputHash: 'fixture-hash' },
    evaluatedCases: 2,
    aggregate: {
      precisionAtK: 0.8,
      recallAtK: 0.7,
      f1: 0.75,
      mrr: 0.9,
      ndcg: 0.85,
    },
    ...overrides,
  };
}

describe('internal benchmark regression gate', () => {
  it('passes an unchanged selected baseline', () => {
    const gate = evaluateBenchmarkRegression(result(), baseline, {
      runner: 'lexical',
      maxMetricDrop: 0,
    });
    expect(gate.passed).toBe(true);
    expect(gate.failures).toEqual([]);
  });

  it('fails metric, hash and case regressions instead of hiding them', () => {
    const gate = evaluateBenchmarkRegression(
      result({
        manifest: { name: 'fixture-corpus', inputHash: 'changed-hash' },
        evaluatedCases: 1,
        aggregate: {
          precisionAtK: 0.5,
          recallAtK: 0.7,
          f1: 0.75,
          mrr: 0.9,
          ndcg: 0.85,
        },
      }),
      baseline,
      { runner: 'lexical', maxMetricDrop: 0.01 },
    );
    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('input hash');
    expect(gate.failures.join(' ')).toContain('Evaluated case count');
    expect(gate.failures.join(' ')).toContain('precisionAtK regressed');
  });

  it('fails product results that introduce scan errors', () => {
    const gate = evaluateBenchmarkRegression(
      result({
        repositories: [{ scan: { errorFiles: 1 } }],
      }),
      baseline,
      { runner: 'lexical', maxMetricDrop: 0.01, maxScanErrors: 0 },
    );
    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('scan errors');
  });

  it('fails closed when a runner has no baseline', () => {
    const gate = evaluateBenchmarkRegression(result(), baseline, { runner: 'missing' });
    expect(gate.passed).toBe(false);
    expect(gate.failures[0]).toContain('No regression baseline');
  });
});
