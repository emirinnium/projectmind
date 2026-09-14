import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateCorpusCaseContract,
  renderCorpusContractMarkdown,
  runCorpusContractAudit,
} from '../../scripts/benchmark/corpus-contract.mjs';

describe('corpus contract evaluator', () => {
  it('requires every expected path to be safe, present and tracked', () => {
    const testCase = { id: 'entry', expectedPaths: ['src/index.ts'] };
    const evidence = {
      existingPaths: ['src/index.ts', 'package.json'],
      trackedPaths: ['src/index.ts', 'package.json'],
      packageMetadataPaths: ['src/index.ts'],
    };
    const result = evaluateCorpusCaseContract(testCase, evidence);

    expect(result).toMatchObject({
      id: 'entry',
      safePaths: true,
      expectedPathsPresent: true,
      expectedPathsTracked: true,
      passed: true,
    });
    expect(result.packageMetadataMatches).toEqual([{ path: 'src/index.ts', referenced: true }]);
  });

  it('fails closed for missing, untracked or escaping expected paths', () => {
    expect(
      evaluateCorpusCaseContract(
        { id: 'missing', expectedPaths: ['src/missing.ts'] },
        { existingPaths: [], trackedPaths: [] },
      ).passed,
    ).toBe(false);
    expect(
      evaluateCorpusCaseContract(
        { id: 'untracked', expectedPaths: ['src/index.ts'] },
        { existingPaths: ['src/index.ts'], trackedPaths: [] },
      ).passed,
    ).toBe(false);
    expect(
      evaluateCorpusCaseContract(
        { id: 'escape', expectedPaths: ['../outside.ts'] },
        { existingPaths: ['../outside.ts'], trackedPaths: ['../outside.ts'] },
      ),
    ).toMatchObject({ safePaths: false, passed: false });
  });

  it('renders integrity metadata and limitations without source content', () => {
    const markdown = renderCorpusContractMarkdown({
      evaluator: { name: 'projectmind-corpus-contract', version: 1 },
      manifest: { name: 'fixture', inputHash: 'a'.repeat(64), repositories: 1, cases: 1 },
      repositories: [
        {
          id: 'fixture',
          commitVerified: true,
          metadata: { sourceFileCount: 1, loc: 3 },
          cases: [{ id: 'entry' }],
        },
      ],
      passed: true,
      failures: [],
      limitations: ['Labels still require independent review.'],
    });

    expect(markdown).toContain('projectmind-corpus-contract');
    expect(markdown).toContain('Labels still require independent review.');
    expect(markdown).not.toContain('source code');
  });

  it('audits an immutable Git checkout without returning source content', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-corpus-contract-'));
    const checkout = join(root, 'fixture-repo');
    try {
      mkdirSync(join(checkout, 'src'), { recursive: true });
      writeFileSync(join(checkout, 'src', 'index.ts'), 'export const answer = 42;\n', 'utf8');
      writeFileSync(
        join(checkout, 'package.json'),
        JSON.stringify({ name: 'fixture-repo', main: 'src/index.ts' }),
        'utf8',
      );

      const git = (args: string[]): string =>
        execFileSync('git', args, {
          cwd: checkout,
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      git(['init', '-q']);
      git(['config', 'user.email', 'projectmind-fixture@example.invalid']);
      git(['config', 'user.name', 'ProjectMind Fixture']);
      git(['add', '.']);
      git(['commit', '-qm', 'fixture']);
      const commitSha = git(['rev-parse', 'HEAD']);

      const result = runCorpusContractAudit(
        {
          version: 1,
          name: 'fixture-corpus',
          access: 'fixture',
          repositories: [
            {
              id: 'fixture-repo',
              url: 'https://example.invalid/fixture-repo.git',
              commitSha,
              license: 'MIT',
              languages: ['typescript'],
            },
          ],
          cases: [
            {
              repositoryId: 'fixture-repo',
              case: {
                id: 'entry',
                query: 'entry point',
                expectedPaths: ['src/index.ts'],
                labeling: {
                  status: 'single-reviewer',
                  reviewers: ['fixture-reviewer'],
                  method: 'source-inspection',
                  evidence: ['fixture entry path'],
                },
              },
            },
          ],
        },
        { 'fixture-repo': checkout },
      );

      expect(result).toMatchObject({ passed: true, manifest: { repositories: 1, cases: 1 } });
      expect(result.repositories[0]).toMatchObject({
        actualCommit: commitSha,
        commitVerified: true,
        metadata: { sourceFileCount: 1, loc: 1 },
        cases: [{ passed: true, expectedPathsTracked: true }],
      });
      const report = renderCorpusContractMarkdown(result);
      expect(report).toContain('fixture-repo');
      expect(report).not.toContain(readFileSync(join(checkout, 'src', 'index.ts'), 'utf8'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
