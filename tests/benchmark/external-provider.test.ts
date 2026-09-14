import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renderExternalProviderMarkdown,
  runExternalProviderCorpusBenchmark,
} from '../../scripts/benchmark/external-provider.mjs';

const manifest = {
  version: 1,
  name: 'external-provider-fixture',
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
        id: 'config-search',
        kind: 'search',
        query: 'configuration',
        expectedPaths: ['src/config.ts'],
        aliases: [],
        unknown: false,
        labeling: {
          status: 'single-reviewer',
          reviewers: ['fixture-reviewer'],
          method: 'source-inspection',
          evidence: ['Fixture path selected from the known source file.'],
        },
      },
    },
  ],
};

describe('external provider benchmark harness', () => {
  it('scores a provider response while keeping source and response content out of evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-external-provider-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'config.ts'), 'export const configuration = true;\n');
      writeFileSync(join(root, 'src', 'other.ts'), 'export const unrelated = false;\n');
      const result = await runExternalProviderCorpusBenchmark(
        manifest,
        { 'fixture-repo': root },
        {
          model: 'fixture/model',
          verifyCommits: false,
          provider: {
            name: 'fixture-provider',
            model: 'fixture/model',
            analyze: async () => ({
              content: '{"paths":["src/config.ts"]}',
              reasoningTrace: [],
              confidence: 1,
              usage: { inputTokens: 10, outputTokens: 4 },
              responseTimeMs: 2,
              responseMode: 'content',
              finishReason: 'stop',
            }),
          },
        },
      );
      expect(result.aggregate.mrr).toBe(1);
      expect(result.evaluatedCases).toBe(1);
      expect(result.labelStatus).toBe('single-reviewer');
      expect(JSON.stringify(result)).not.toContain('export const configuration');
      expect(renderExternalProviderMarkdown(result)).toContain('single-reviewer');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for invalid paths and records the untrusted output shape', async () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-external-provider-invalid-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'config.ts'), 'export const configuration = true;\n');
      const result = await runExternalProviderCorpusBenchmark(
        manifest,
        { 'fixture-repo': root },
        {
          model: 'fixture/model',
          verifyCommits: false,
          provider: {
            name: 'fixture-provider',
            model: 'fixture/model',
            analyze: async () => ({
              content: '{"paths":["../../outside.ts"]}',
              reasoningTrace: [],
              confidence: 1,
              responseTimeMs: 1,
              responseMode: 'content',
            }),
          },
        },
      );
      expect(result.repositories[0]?.cases[0]?.status).toBe('invalid-output');
      expect(result.repositories[0]?.cases[0]?.actual).toEqual([]);
      expect(result.evaluatedCases).toBe(0);
      expect(JSON.stringify(result)).not.toContain('outside.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not score reasoning-only provider output as a search result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-external-provider-reasoning-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'config.ts'), 'export const configuration = true;\n');
      const result = await runExternalProviderCorpusBenchmark(
        manifest,
        { 'fixture-repo': root },
        {
          model: 'fixture/model',
          verifyCommits: false,
          provider: {
            name: 'fixture-provider',
            model: 'fixture/model',
            analyze: async () => ({
              content: '',
              reasoningTrace: ['not evidence'],
              confidence: 1,
              usage: { inputTokens: 10, outputTokens: 40 },
              responseTimeMs: 3,
              responseMode: 'reasoning-only',
              finishReason: 'length',
            }),
          },
        },
      );
      expect(result.evaluatedCases).toBe(0);
      expect(result.repositories[0]?.cases[0]?.status).toBe('unmeasured-response');
      expect(result.repositories[0]?.cases[0]?.score?.evaluated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
