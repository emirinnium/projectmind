import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renderProductCorpusBenchmarkMarkdown,
  runProductCorpusBenchmark,
} from '../../scripts/benchmark/product.mjs';

describe('product-path benchmark evaluator', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('measures the real scanner, graph and intent-search path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-product-benchmark-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'auth.ts'),
      'export function validateAuthToken(token: string): boolean { return token.length > 0; }\n',
      'utf8',
    );
    writeFileSync(join(root, 'src', 'unrelated.ts'), 'export const theme = "dark";\n', 'utf8');

    const result = await runProductCorpusBenchmark(
      {
        version: 1,
        name: 'product-fixture',
        access: 'fixture',
        repositories: [
          {
            id: 'fixture-repo',
            url: 'https://example.com/fixture-repo',
            commitSha: 'a'.repeat(40),
            license: 'MIT',
            languages: ['typescript'],
          },
        ],
        cases: [
          {
            repositoryId: 'fixture-repo',
            case: {
              id: 'auth-search',
              query: 'validate auth token',
              expectedPaths: ['src/auth.ts'],
            },
          },
        ],
      },
      { 'fixture-repo': root },
      { verifyCommits: false, provider: 'simple', limit: 1 },
    );

    expect(result.evaluator.productPath).toContain('IntentEngine.search');
    expect(result.repositories[0]?.scan).toMatchObject({
      totalFiles: 2,
      scannedFiles: 2,
      errorFiles: 0,
    });
    expect(result.repositories[0]?.provider).toMatchObject({
      requested: 'simple',
      active: 'simple',
      fellBack: false,
    });
    expect(result.scores[0]?.actual).toEqual(['src/auth.ts']);
    expect(result.scores[0]?.evaluated).toBe(true);
    expect(result.aggregate.evaluatedCases).toBe(1);
    expect(result.manifest.inputHash).toMatch(/^[a-f0-9]{64}$/iu);
    expect(renderProductCorpusBenchmarkMarkdown(result)).toContain('IntentEngine.search');

    const repeat = await runProductCorpusBenchmark(
      {
        version: 1,
        name: 'product-fixture',
        access: 'fixture',
        repositories: [
          {
            id: 'fixture-repo',
            url: 'https://example.com/fixture-repo',
            commitSha: 'a'.repeat(40),
            license: 'MIT',
            languages: ['typescript'],
          },
        ],
        cases: [
          {
            repositoryId: 'fixture-repo',
            case: {
              id: 'auth-search',
              query: 'validate auth token',
              expectedPaths: ['src/auth.ts'],
            },
          },
        ],
      },
      { 'fixture-repo': root },
      { verifyCommits: false, provider: 'simple', limit: 1 },
    );
    expect(repeat.manifest.inputHash).toBe(result.manifest.inputHash);
  });

  it('creates an isolated graph namespace for every repository checkout', async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'projectmind-product-one-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'projectmind-product-two-'));
    roots.push(firstRoot, secondRoot);
    mkdirSync(join(firstRoot, 'src'), { recursive: true });
    mkdirSync(join(secondRoot, 'src'), { recursive: true });
    writeFileSync(join(firstRoot, 'src', 'alpha.ts'), 'export const alphaSignal = true;\n', 'utf8');
    writeFileSync(join(secondRoot, 'src', 'beta.ts'), 'export const betaSignal = true;\n', 'utf8');

    const result = await runProductCorpusBenchmark(
      {
        version: 1,
        name: 'isolation-fixture',
        access: 'fixture',
        repositories: [
          {
            id: 'repo-one',
            url: 'https://example.com/repo-one',
            commitSha: 'b'.repeat(40),
            license: 'MIT',
            languages: ['typescript'],
          },
          {
            id: 'repo-two',
            url: 'https://example.com/repo-two',
            commitSha: 'c'.repeat(40),
            license: 'MIT',
            languages: ['typescript'],
          },
        ],
        cases: [
          {
            repositoryId: 'repo-one',
            case: { id: 'alpha', query: 'alpha signal', expectedPaths: ['src/alpha.ts'] },
          },
          {
            repositoryId: 'repo-two',
            case: { id: 'beta', query: 'beta signal', expectedPaths: ['src/beta.ts'] },
          },
        ],
      },
      { 'repo-one': firstRoot, 'repo-two': secondRoot },
      { verifyCommits: false, provider: 'simple', limit: 1 },
    );

    expect(result.repositories).toHaveLength(2);
    expect(
      result.repositories.every((repository: unknown) => {
        const scan = (repository as { scan?: { errorFiles?: number | null } }).scan;
        return scan?.errorFiles === 0;
      }),
    ).toBe(true);
    expect(result.scores.map((score) => score.actual)).toEqual([['src/alpha.ts'], ['src/beta.ts']]);
    expect(result.aggregate.recallAtK).toBe(1);
  });

  it('measures product impact, dead-code and reflected review cases when contracts are present', async () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-product-kinds-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'target.ts'), 'export const target = true;\n', 'utf8');
    writeFileSync(
      join(root, 'src', 'consumer.ts'),
      "import { target } from './target';\nexport const consumer = target;\n",
      'utf8',
    );
    writeFileSync(join(root, 'src', 'unused.ts'), 'export const unused = true;\n', 'utf8');
    writeFileSync(
      join(root, 'src', 'review.ts'),
      'const value: any = 1; // TODO: replace\n',
      'utf8',
    );

    const result = await runProductCorpusBenchmark(
      {
        version: 1,
        name: 'product-kinds-fixture',
        access: 'fixture',
        repositories: [
          {
            id: 'fixture-repo',
            url: 'https://example.com/fixture-repo',
            commitSha: 'd'.repeat(40),
            license: 'MIT',
            languages: ['typescript'],
          },
        ],
        cases: [
          {
            repositoryId: 'fixture-repo',
            case: {
              id: 'impact',
              kind: 'impact',
              query: 'target impact',
              targetPath: 'src/target.ts',
              expectedPaths: ['src/consumer.ts'],
            },
          },
          {
            repositoryId: 'fixture-repo',
            case: {
              id: 'dead-code',
              kind: 'dead-code',
              query: 'unused module',
              expectedPaths: ['src/unused.ts'],
            },
          },
          {
            repositoryId: 'fixture-repo',
            case: {
              id: 'review',
              kind: 'review',
              query: 'review changed code',
              changedPaths: ['src/review.ts'],
              expectedPaths: ['src/review.ts'],
            },
          },
        ],
      },
      { 'fixture-repo': root },
      { verifyCommits: false, provider: 'simple', limit: 5 },
    );

    expect(result.scores).toHaveLength(3);
    expect(result.scores[0]?.actual).toContain('src/consumer.ts');
    expect(result.scores[1]?.actual).toContain('src/unused.ts');
    expect(result.scores[2]?.actual).toEqual(['src/review.ts']);
    expect(result.scores.every((score) => score.evaluated)).toBe(true);
  });
});
