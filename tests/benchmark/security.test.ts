import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renderSecurityBenchmarkMarkdown,
  runSecurityPatternBenchmark,
} from '../../scripts/benchmark/security.mjs';
import { scanStaticSecurityPatterns } from '../../src/core/security/static-audit.js';

describe('security benchmark harness', () => {
  it('measures deterministic security candidates and preserves line-level evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-security-benchmark-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'tests'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'unsafe.ts'),
        'const token = "fixture-secret";\nconst value = eval(input);\n',
        'utf8',
      );
      writeFileSync(
        join(root, 'tests', 'probe.test.ts'),
        'const password = "test-only";\n',
        'utf8',
      );

      const result = runSecurityPatternBenchmark(root);
      expect(result.filesScanned).toBe(1);
      expect(result.filesSkipped).toBe(1);
      expect(result.findings.map((finding) => [finding.file, finding.line, finding.type])).toEqual([
        ['src/unsafe.ts', 1, 'secret'],
        ['src/unsafe.ts', 2, 'eval'],
      ]);
      expect(result.bySeverity).toEqual({ critical: 0, high: 2, medium: 0 });
      expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.limitations).toHaveLength(3);
      expect(renderSecurityBenchmarkMarkdown(result)).toContain('| High | 2 |');

      const includeTests = runSecurityPatternBenchmark(root, { includeTests: true });
      expect(includeTests.findings.some((finding) => finding.file.includes('probe.test.ts'))).toBe(
        true,
      );
      expect(includeTests.inputHash).not.toBe(result.inputHash);
      expect(scanStaticSecurityPatterns('eval(a); eval(b);', 'fixture.ts')).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps empty and non-security categories explicit', () => {
    expect(
      scanStaticSecurityPatterns('const safe = true;', 'safe.ts', new Set(['crypto'])),
    ).toEqual([]);
    expect(
      scanStaticSecurityPatterns('const digest = "sha1";', 'hash.ts', new Set(['crypto'])),
    ).toEqual([expect.objectContaining({ type: 'weak-hash', severity: 'medium', line: 1 })]);
  });
});
