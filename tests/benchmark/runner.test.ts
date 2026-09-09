import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseBenchmarkManifest } from '../../src/core/benchmark/manifest.js';
import {
  parseBenchmarkRunResult,
  renderBenchmarkMarkdown,
  runLexicalSearch,
  runBenchmark,
} from '../../src/core/benchmark/runner.js';
import { parseBenchmarkCorpusManifest } from '../../src/core/benchmark/manifest.js';

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
    expect(first.filesIndexed).toBe(1);
    expect(first.scores[0]?.f1).toBeGreaterThan(0);
    expect(renderBenchmarkMarkdown(first)).toContain('| F1 |');
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
});
