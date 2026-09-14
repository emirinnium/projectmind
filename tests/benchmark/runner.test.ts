import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseBenchmarkManifest,
  BenchmarkLabelingSchema,
} from '../../scripts/benchmark/manifest.mjs';
import {
  parseBenchmarkRunResult,
  renderBenchmarkMarkdown,
  renderBenchmarkSarif,
  renderCorpusBenchmarkMarkdown,
  runCorpusBenchmark,
  runLexicalSearch,
  runBenchmark,
} from '../../scripts/benchmark/runner.mjs';
import { parseBenchmarkCorpusManifest } from '../../scripts/benchmark/manifest.mjs';
import { evaluateBenchmarkGate } from '../../scripts/benchmark/gate.mjs';

type BenchmarkScore = ReturnType<typeof runBenchmark>['scores'][number];

describe('offline benchmark runner', () => {
  it('is deterministic, honors .pmignore and round-trips its typed report', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-benchmark-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'generated'));
    writeFileSync(join(root, '.pmignore'), 'generated/\n', 'utf8');
    writeFileSync(join(root, 'src', 'auth.ts'), 'export const authToken = "safe";\n', 'utf8');
    writeFileSync(
      join(root, 'generated', 'auth.ts'),
      'export const authToken = "generated";\n',
      'utf8',
    );
    const manifest = parseBenchmarkManifest({
      version: 1,
      name: 'fixture',
      license: 'MIT',
      access: 'fixture',
      seed: 7,
      cases: [{ id: 'auth', query: 'auth token', expectedPaths: ['src/auth.ts'], kind: 'search' }],
    });
    const first = runBenchmark(manifest, root);
    const second = runBenchmark(manifest, root);
    expect(first.manifest).toEqual(second.manifest);
    expect(first.scores).toEqual(second.scores);
    expect(first.observations).toEqual(second.observations);
    expect(first.filesIndexed).toBe(1);
    expect(first.scores[0]?.f1).toBeGreaterThan(0);
    expect(renderBenchmarkMarkdown(first)).toContain('| F1 |');
    expect(renderBenchmarkMarkdown(first)).toContain('Observed paths');
    const sarif = JSON.parse(renderBenchmarkSarif(first)) as {
      version: string;
      runs: Array<{
        results: Array<{
          locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
        }>;
      }>;
    };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe(
      'src/auth.ts',
    );
    expect(parseBenchmarkRunResult(JSON.parse(JSON.stringify(first))).aggregate).toEqual(
      first.aggregate,
    );
  });

  it('validates metadata-first corpus links and exposes a bounded search benchmark', () => {
    const corpus = parseBenchmarkCorpusManifest({
      version: 1,
      name: 'fixture-corpus',
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
          case: { id: 'one', query: 'auth', expectedPaths: ['src/auth.ts'] },
        },
      ],
    });
    expect(corpus.repositories).toHaveLength(1);
    expect(() =>
      parseBenchmarkCorpusManifest({
        ...corpus,
        cases: [{ ...corpus.cases[0], repositoryId: 'missing-repo' }],
      }),
    ).toThrow(/unknown repository/);

    const root = mkdtempSync(join(tmpdir(), 'projectmind-search-benchmark-'));
    writeFileSync(join(root, 'auth.ts'), 'export const authToken = true;\n', 'utf8');
    const result = runLexicalSearch('auth token', root, 1);
    expect(result.results[0]?.path).toBe('auth.ts');
    expect(result.results).toHaveLength(1);
    expect(result.limitations.length).toBeGreaterThan(1);
  });

  it('rejects duplicate repository/case identities and unsafe expected paths', () => {
    const repository = {
      id: 'fixture-repo',
      url: 'https://example.com/fixture-repo',
      commitSha: 'a'.repeat(40),
      license: 'MIT',
      languages: ['typescript'] as const,
    };
    const base = {
      version: 1 as const,
      name: 'fixture-corpus',
      access: 'fixture' as const,
      repositories: [repository],
      cases: [
        {
          repositoryId: 'fixture-repo',
          case: { id: 'one', query: 'auth', expectedPaths: ['src/auth.ts'] },
        },
      ],
    };

    expect(() =>
      parseBenchmarkCorpusManifest({ ...base, repositories: [repository, repository] }),
    ).toThrow(/repository IDs must be unique/i);
    expect(() =>
      parseBenchmarkCorpusManifest({
        ...base,
        cases: [base.cases[0], base.cases[0]],
      }),
    ).toThrow(/case IDs must be unique/i);
    expect(() =>
      parseBenchmarkCorpusManifest({
        ...base,
        cases: [
          {
            repositoryId: 'fixture-repo',
            case: { id: 'unsafe', query: 'auth', expectedPaths: ['..\\secret.ts'] },
          },
        ],
      }),
    ).toThrow(/unsafe expected path/i);
    expect(() =>
      parseBenchmarkCorpusManifest({
        ...base,
        cases: [
          {
            repositoryId: 'fixture-repo',
            case: {
              id: 'unsafe-target',
              kind: 'impact',
              query: 'impact',
              targetPath: '../secret.ts',
              expectedPaths: ['src/auth.ts'],
            },
          },
        ],
      }),
    ).toThrow(/unsafe expected path/i);
    expect(() =>
      parseBenchmarkCorpusManifest({
        ...base,
        cases: [
          {
            repositoryId: 'fixture-repo',
            case: {
              id: 'unsafe-change',
              kind: 'review',
              query: 'review',
              changedPaths: ['C:\\secret.ts'],
              expectedPaths: ['src/auth.ts'],
            },
          },
        ],
      }),
    ).toThrow(/unsafe expected path/i);
  });

  it('does not allow an independent label without two distinct reviewers', () => {
    expect(() =>
      BenchmarkLabelingSchema.parse({
        status: 'independently-verified',
        reviewers: ['only-reviewer'],
        method: 'source-inspection',
        evidence: ['one inspection'],
      }),
    ).toThrow(/two distinct reviewers/i);
    expect(() =>
      BenchmarkLabelingSchema.parse({
        status: 'single-reviewer',
        reviewers: ['same-reviewer', 'same-reviewer'],
        method: 'source-inspection',
        evidence: ['duplicate identities'],
      }),
    ).toThrow(/unique/i);
  });

  it('keeps the five-repository corpus metadata-first and label-status explicit', () => {
    const manifest = parseBenchmarkCorpusManifest(
      JSON.parse(
        readFileSync(
          join(process.cwd(), 'benchmarks', 'private-5-repository.manifest.json'),
          'utf8',
        ),
      ) as unknown,
    );
    expect(manifest.repositories).toHaveLength(5);
    expect(manifest.cases).toHaveLength(6);
    expect(manifest.cases.every((item) => item.case.labeling?.status === 'single-reviewer')).toBe(
      true,
    );
    expect(manifest.cases.every((item) => item.case.expectedPaths.length > 0)).toBe(true);
  });

  it('keeps the expanded twenty-repository corpus immutable and label-status explicit', () => {
    const manifest = parseBenchmarkCorpusManifest(
      JSON.parse(
        readFileSync(
          join(process.cwd(), 'benchmarks', 'private-20-repository.manifest.json'),
          'utf8',
        ),
      ) as unknown,
    );
    expect(manifest.repositories).toHaveLength(20);
    expect(manifest.cases).toHaveLength(20);
    expect(new Set(manifest.repositories.map((repository) => repository.id)).size).toBe(20);
    expect(
      manifest.repositories.every((repository) => /^[a-f0-9]{40}$/iu.test(repository.commitSha)),
    ).toBe(true);
    expect(manifest.cases.every((item) => item.case.labeling?.status === 'single-reviewer')).toBe(
      true,
    );
    expect(manifest.cases.every((item) => item.case.expectedPaths.length > 0)).toBe(true);
  });

  it('runs a metadata-first corpus over mapped local checkouts without network access', () => {
    const repositoriesRoot = mkdtempSync(join(tmpdir(), 'projectmind-corpus-'));
    const checkout = join(repositoriesRoot, 'fixture-repo');
    mkdirSync(join(checkout, 'src'), { recursive: true });
    writeFileSync(join(checkout, 'src', 'auth.ts'), 'export const authToken = true;\n', 'utf8');
    const corpus = parseBenchmarkCorpusManifest({
      version: 1,
      name: 'local-corpus',
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
          case: { id: 'auth', query: 'auth token', expectedPaths: ['src/auth.ts'] },
        },
      ],
    });

    const result = runCorpusBenchmark(
      corpus,
      { 'fixture-repo': checkout },
      { verifyCommits: false },
    );

    expect(result.manifest.repositories).toBe(1);
    expect(result.manifest.cases).toBe(1);
    expect(result.evaluatedCases).toBe(1);
    expect(result.aggregate.recallAtK).toBe(1);
    expect(result.repositories[0]).toMatchObject({
      repositoryId: 'fixture-repo',
      commitVerified: false,
      result: { aggregate: { evaluatedCases: 1 } },
    });
    expect(result.manifest.independentlyVerifiedCases).toBe(0);
    expect(renderCorpusBenchmarkMarkdown(result)).toContain('not public-quality verified');
    expect(evaluateBenchmarkGate(result, { requireIndependentLabels: true }).passed).toBe(false);
    expect(evaluateBenchmarkGate(result, { minimumRecallAtK: 1 }).passed).toBe(true);
  });

  it('evaluates impact, dead-code, and review cases with explicit static limitations', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-benchmark-kinds-'));
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
      'const value: any = 1; // TODO: review\n',
      'utf8',
    );

    const result = runBenchmark(
      parseBenchmarkManifest({
        version: 1,
        name: 'static-evaluators',
        license: 'fixture',
        access: 'fixture',
        seed: 0,
        cases: [
          { id: 'impact', kind: 'impact', query: 'target', expectedPaths: ['src/consumer.ts'] },
          { id: 'dead', kind: 'dead-code', query: 'unused', expectedPaths: ['src/unused.ts'] },
          { id: 'review', kind: 'review', query: 'review', expectedPaths: ['src/review.ts'] },
        ],
      }),
      root,
    );

    expect(result.scores.every((score: BenchmarkScore) => score.evaluated)).toBe(true);
    expect(result.scores.map((score: BenchmarkScore) => score.recallAtK)).toEqual([1, 1, 1]);
    expect(result.limitations.join(' ')).toContain('dynamic imports');
    expect(result.limitations.join(' ')).toContain('Dead-code benchmark');
    expect(result.limitations.join(' ')).toContain('Review benchmark');
  });

  it('reports missing and mismatched repository checkouts instead of inventing scores', () => {
    const corpus = parseBenchmarkCorpusManifest({
      version: 1,
      name: 'missing-corpus',
      access: 'fixture',
      repositories: [
        {
          id: 'missing-repo',
          url: 'https://example.com/missing-repo',
          commitSha: 'a'.repeat(40),
          license: 'MIT',
          languages: ['typescript'],
        },
      ],
      cases: [
        {
          repositoryId: 'missing-repo',
          case: { id: 'unknown', query: 'not present', expectedPaths: [], unknown: true },
        },
      ],
    });

    const result = runCorpusBenchmark(corpus, {});

    expect(result.evaluatedCases).toBe(0);
    expect(result.aggregate.evaluatedCases).toBe(0);
    expect(result.repositories[0]?.result).toBeNull();
    expect(result.limitations.join('\n')).toContain('checkout is missing');
  });
});
