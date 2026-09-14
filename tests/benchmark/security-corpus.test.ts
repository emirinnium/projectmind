import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renderSecurityCorpusBenchmarkMarkdown,
  runSecurityCorpusBenchmark,
} from '../../scripts/benchmark/security-corpus.mjs';

describe('internal security corpus benchmark', () => {
  it('verifies repository identity and aggregates static candidates without source text', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-security-corpus-'));
    const repositoryRoot = join(root, 'fixture');
    mkdirSync(repositoryRoot, { recursive: true });
    writeFileSync(join(repositoryRoot, 'unsafe.ts'), 'const value = eval(input);\n', 'utf8');
    try {
      const manifest = {
        version: 1 as const,
        name: 'security-fixture',
        access: 'fixture' as const,
        repositories: [
          {
            id: 'fixture-repo',
            url: 'https://example.com/fixture.git',
            commitSha: 'a'.repeat(40),
            license: 'MIT',
            languages: ['typescript' as const],
          },
        ],
        cases: [
          {
            repositoryId: 'fixture-repo',
            case: {
              id: 'case',
              query: 'eval',
              expectedPaths: ['unsafe.ts'],
              aliases: [],
              unknown: false,
              kind: 'search' as const,
            },
          },
        ],
      };
      const missing = runSecurityCorpusBenchmark(manifest, { 'fixture-repo': repositoryRoot });
      expect(missing.repositories[0]?.commitVerified).toBe(false);
      expect(missing.candidateFindings).toBe(0);

      const unverified = runSecurityCorpusBenchmark(
        manifest,
        { 'fixture-repo': repositoryRoot },
        { verifyCommits: false },
      );
      expect(unverified.repositories[0]?.commitVerified).toBe(false);
      expect(unverified.candidateFindings).toBeGreaterThan(0);
      expect(JSON.stringify(unverified)).not.toContain('eval(input)');
      expect(renderSecurityCorpusBenchmarkMarkdown(unverified)).toContain('Candidate findings');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
