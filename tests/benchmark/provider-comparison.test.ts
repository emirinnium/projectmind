import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renderProviderComparisonMarkdown,
  runProviderComparison,
} from '../../scripts/benchmark/provider-comparison.mjs';

const manifest = {
  version: 1,
  name: 'provider-comparison-fixture',
  access: 'fixture',
  repositories: [
    {
      id: 'fixture-repo',
      url: 'https://example.com/fixture-repo.git',
      commitSha: 'a'.repeat(40),
      license: 'MIT',
      languages: ['typescript'],
    },
  ],
  cases: [
    {
      repositoryId: 'fixture-repo',
      case: {
        id: 'entry',
        kind: 'search',
        query: 'configuration',
        expectedPaths: ['src/config.ts'],
        aliases: [],
        unknown: false,
      },
    },
  ],
};

describe('provider comparison benchmark harness', () => {
  it('runs each provider through an isolated product evaluator and renders deltas', async () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-provider-comparison-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'config.ts'), 'export const configuration = true;\n');
      const result = await runProviderComparison(
        manifest,
        { 'fixture-repo': root },
        { providers: ['simple'], verifyCommits: false },
      );
      expect(result.complete).toBe(true);
      expect(result.comparisons).toHaveLength(1);
      expect(result.comparisons[0]?.provider).toBe('simple');
      expect(result.comparisons[0]).toMatchObject({
        deltaFromBaseline: {
          precisionAtK: 0,
          recallAtK: 0,
          f1: 0,
          mrr: 0,
          ndcg: 0,
        },
      });
      expect(renderProviderComparisonMarkdown(result)).toContain('| simple | completed |');
      expect(JSON.stringify(result)).not.toContain('export const configuration');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects duplicate or unsupported providers instead of hiding comparison gaps', async () => {
    await expect(
      runProviderComparison(manifest, {}, { providers: ['simple', 'simple'] }),
    ).rejects.toThrow(/unique/);
    await expect(runProviderComparison(manifest, {}, { providers: ['unknown'] })).rejects.toThrow(
      /unsupported/i,
    );
  });

  it('marks an unavailable requested provider as fallback instead of completed', () => {
    const report = renderProviderComparisonMarkdown({
      benchmark: 'projectmind-provider-comparison',
      baselineProvider: 'simple',
      inputHash: 'a'.repeat(64),
      complete: false,
      comparisons: [
        {
          provider: 'transformers',
          status: 'fallback',
          activeProviders: ['simple'],
          evaluatedCases: 1,
          aggregate: {
            precisionAtK: 1,
            recallAtK: 1,
            f1: 1,
            mrr: 1,
            ndcg: 1,
          },
          limitations: ['requested provider unavailable'],
        },
      ],
      limitations: ['requested provider unavailable'],
    });
    expect(report).toContain('| transformers | fallback | simple |');
    expect(report).not.toContain('| transformers | completed |');
  });
});
