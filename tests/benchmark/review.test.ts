import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseBenchmarkManifest } from '../../scripts/benchmark/manifest.mjs';
import {
  renderBenchmarkMarkdown,
  renderBenchmarkSarif,
  runBenchmark,
} from '../../scripts/benchmark/runner.mjs';
import { DEFAULT_REVIEW_POLICY } from '../../src/core/review/policy.js';
import { planReviewBundles } from '../../src/core/review/bundle.js';
import {
  reflectFindings,
  validateFindingPositions,
  verifiedFindings,
} from '../../src/core/review/finding-validation.js';
import { collectReviewFindings } from '../../src/cli/commands/pr-preview-engine.js';

describe('review benchmark harness', () => {
  it('measures deterministic rule candidates and validates them through bundle reflection', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-review-benchmark-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'changed.ts'), 'const value: any = 1; // TODO: replace\n');
      writeFileSync(join(root, 'src', 'safe.ts'), 'export const safe = true;\n');

      const manifest = parseBenchmarkManifest({
        version: 1,
        name: 'review-fixture',
        license: 'fixture',
        access: 'fixture',
        cases: [
          {
            id: 'review-candidates',
            kind: 'review',
            query: 'review debt',
            expectedPaths: ['src/changed.ts'],
          },
        ],
      });
      const result = runBenchmark(manifest, root);
      expect(result.scores[0]).toMatchObject({ evaluated: true, recallAtK: 1 });
      expect(renderBenchmarkMarkdown(result)).toContain('review-candidates');
      expect(JSON.parse(renderBenchmarkSarif(result)).runs[0].results).toHaveLength(1);

      const plan = planReviewBundles(['src/changed.ts'], root, DEFAULT_REVIEW_POLICY);
      const generated = collectReviewFindings(['src/changed.ts'], root, DEFAULT_REVIEW_POLICY);
      expect(generated.length).toBeGreaterThan(0);
      const validated = validateFindingPositions(generated, plan, root);
      const reflected = reflectFindings(validated, DEFAULT_REVIEW_POLICY, root);
      expect(verifiedFindings(reflected).length).toBe(generated.length);
      expect(reflected.every((finding) => finding.status === 'verified')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
