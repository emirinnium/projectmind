import { describe, expect, it } from 'vitest';
import { evaluateBenchmarkGate } from '../../scripts/benchmark/gate.mjs';

interface CorpusBenchmarkResult {
  manifest: {
    name: string;
    version: number;
    access: 'public' | 'private' | 'fixture';
    repositories: number;
    cases: number;
    independentlyVerifiedCases: number;
    pendingLabelCases: number;
    inputHash: string;
  };
  repositories: Array<{
    repositoryId: string;
    checkoutPath: string;
    expectedCommit: string;
    actualCommit: string | null;
    commitVerified: boolean;
    result: unknown;
    limitations: string[];
  }>;
  aggregate: {
    cases: number;
    evaluatedCases: number;
    precisionAtK: number;
    recallAtK: number;
    f1: number;
    mrr: number;
    ndcg: number;
  };
  evaluatedCases: number;
  unknownCases: number;
  durationMs: number;
  limitations: string[];
}

type BenchmarkResultOverrides = Partial<Omit<CorpusBenchmarkResult['manifest'], 'repositories'>> & {
  evaluatedCases?: number;
  repositories?: CorpusBenchmarkResult['repositories'];
};

function benchmarkResult(overrides: BenchmarkResultOverrides = {}): CorpusBenchmarkResult {
  const { evaluatedCases, repositories: repositoryOverrides, ...manifestOverrides } = overrides;
  const manifest: CorpusBenchmarkResult['manifest'] = {
    name: 'fixture',
    version: 1,
    access: 'fixture',
    repositories: 1,
    cases: 2,
    independentlyVerifiedCases: 2,
    pendingLabelCases: 0,
    inputHash: 'a'.repeat(64),
    ...manifestOverrides,
  };
  return {
    manifest,
    repositories: repositoryOverrides ?? [
      {
        repositoryId: 'fixture-repo',
        checkoutPath: '/fixture',
        expectedCommit: 'a'.repeat(40),
        actualCommit: 'a'.repeat(40),
        commitVerified: true,
        result: null,
        limitations: [],
      },
    ],
    aggregate: {
      cases: manifest.cases,
      evaluatedCases: evaluatedCases ?? 2,
      precisionAtK: 0.8,
      recallAtK: 0.75,
      f1: 0.77,
      mrr: 0.7,
      ndcg: 0.8,
    },
    evaluatedCases: evaluatedCases ?? 2,
    unknownCases: 0,
    durationMs: 1,
    limitations: [],
  };
}

describe('benchmark release gate', () => {
  it('passes a fully evidenced result against configured thresholds', () => {
    expect(
      evaluateBenchmarkGate(benchmarkResult(), {
        minimumEvaluatedCases: 2,
        minimumRecallAtK: 0.75,
        minimumF1: 0.77,
        minimumMrr: 0.7,
        requireIndependentLabels: true,
        requireVerifiedCommits: true,
      }),
    ).toEqual({ passed: true, failures: [] });
  });

  it('reports every missing evidence condition instead of converting it to a pass', () => {
    const result = benchmarkResult({
      independentlyVerifiedCases: 0,
      pendingLabelCases: 2,
      evaluatedCases: 0,
      repositories: [
        {
          repositoryId: 'fixture-repo',
          checkoutPath: '/fixture',
          expectedCommit: 'a'.repeat(40),
          actualCommit: 'b'.repeat(40),
          commitVerified: false,
          result: null,
          limitations: ['mismatch'],
        },
      ],
    });
    const gate = evaluateBenchmarkGate(result, {
      minimumEvaluatedCases: 1,
      minimumRecallAtK: 0.7501,
      minimumF1: 0.7701,
      minimumMrr: 0.7001,
      requireIndependentLabels: true,
      requireVerifiedCommits: true,
    });
    expect(gate.passed).toBe(false);
    expect(gate.failures).toEqual([
      'Only 0 benchmark case(s) were evaluated; at least 1 are required.',
      'Recall@k 0.7500 is below 0.7501.',
      'F1 0.7700 is below 0.7701.',
      'MRR 0.7000 is below 0.7001.',
      '2 case(s) lack independent labels; public quality gating is blocked.',
      'One or more repository checkouts are not verified at their manifest commit.',
    ]);
  });
});
