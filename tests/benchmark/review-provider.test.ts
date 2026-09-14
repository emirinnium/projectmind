import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renderIsolatedReviewBenchmarkMarkdown,
  renderIsolatedReviewBenchmarkSarif,
  runIsolatedReviewProviderBenchmark,
} from '../../scripts/benchmark/review-provider.mjs';

describe('isolated review provider benchmark fixture', () => {
  it('runs each deterministic review bundle in a disposable process and validates findings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-review-provider-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'changed.ts'), 'const value: any = 1; // TODO: replace\n');
      const result = await runIsolatedReviewProviderBenchmark({
        projectRoot: root,
        changedFiles: ['src/changed.ts'],
        timeoutMs: 10_000,
      });
      expect(result.provider.processIsolated).toBe(true);
      expect(result.complete).toBe(true);
      expect(result.bundles).toHaveLength(1);
      expect(result.bundles[0]?.status).toBe('completed');
      expect(result.generatedFindings).toBeGreaterThan(0);
      expect(result.verifiedFindings).toBe(result.generatedFindings);
      expect(
        result.findings.every((finding: { status: string }) => finding.status === 'verified'),
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain('const value: any');
      expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.tokenizer.mode).toBe('heuristic');
      expect(result.bundles[0]?.providerInputTokens).toBeGreaterThan(0);
      expect(result.bundles[0]?.providerOutputTokens).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('renders only verified line findings as review SARIF and source-free Markdown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-review-provider-report-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      const source = 'const value: any = 1; // TODO: replace\n';
      writeFileSync(join(root, 'src', 'changed.ts'), source);
      const result = await runIsolatedReviewProviderBenchmark({
        projectRoot: root,
        changedFiles: ['src/changed.ts'],
        timeoutMs: 10_000,
      });
      const sarif = JSON.parse(renderIsolatedReviewBenchmarkSarif(result));
      const markdown = renderIsolatedReviewBenchmarkMarkdown(result);
      expect(sarif.version).toBe('2.1.0');
      expect(sarif.runs[0].results.length).toBe(result.verifiedFindings);
      expect(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine).toBe(1);
      expect(markdown).toContain('| src/changed.ts | 1 |');
      expect(markdown).toContain('Provider input tokens');
      expect(markdown).not.toContain(source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects an outside or ignored changed path before starting a child process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-review-provider-boundary-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'safe.ts'), 'export const safe = true;\n');
      await expect(
        runIsolatedReviewProviderBenchmark({
          projectRoot: root,
          changedFiles: ['../outside.ts'],
        }),
      ).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
