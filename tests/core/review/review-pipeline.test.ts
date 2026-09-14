import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planReviewBundles } from '../../../src/core/review/bundle.js';
import {
  validateFindingPositions,
  reflectFindings,
  verifiedFindings,
} from '../../../src/core/review/finding-validation.js';
import { DEFAULT_REVIEW_POLICY, parseReviewPolicy } from '../../../src/core/review/policy.js';
import { collectReviewFindings } from '../../../src/cli/commands/pr-preview-engine.js';
import { ruleMatchesSourceLine } from '../../../src/core/review/rules.js';

describe('deterministic review pipeline', () => {
  it('does not treat comments or strings as explicit any types', () => {
    expect(ruleMatchesSourceLine('explicit-any', '// replace any with unknown')).toBe(false);
    expect(ruleMatchesSourceLine('explicit-any', 'const label = "any";')).toBe(false);
    expect(ruleMatchesSourceLine('explicit-any', 'const value: any = input;')).toBe(true);
  });

  it('splits files deterministically and preserves source metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-review-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2;\r\n');
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    const first = planReviewBundles(['src/b.ts', 'src/a.ts'], root, DEFAULT_REVIEW_POLICY, {
      maxBytes: 10_000,
    });
    const second = planReviewBundles(['src/a.ts', 'src/b.ts'], root, DEFAULT_REVIEW_POLICY, {
      maxBytes: 10_000,
    });
    expect(first).toEqual(second);
    expect(first.bundles[0]?.files.map((file) => file.relativePath)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
    expect(first.bundles[0]?.files[1]?.lineEnding).toBe('crlf');
  });

  it('quarantines a finding that is not source-backed and verifies supported evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-review-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'const value: any = 1;\n');
    const plan = planReviewBundles(['src/a.ts'], root, DEFAULT_REVIEW_POLICY);
    const findings = validateFindingPositions(
      [
        {
          fingerprint: 'a',
          rule: 'explicit-any',
          severity: 'medium',
          file: 'src/a.ts',
          line: 1,
          message: 'old',
        },
        {
          fingerprint: 'b',
          rule: 'explicit-any',
          severity: 'medium',
          file: 'src/missing.ts',
          line: 1,
          message: 'missing',
        },
      ],
      plan,
      root,
    );
    const reflected = reflectFindings(findings, DEFAULT_REVIEW_POLICY, root);
    expect(verifiedFindings(reflected).map((finding) => finding.fingerprint)).toEqual(['a']);
    expect(reflected.find((finding) => finding.fingerprint === 'b')?.status).toBe('unverifiable');
  });

  it('quarantines a finding when the source changed after bundle creation', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-review-stale-bundle-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'const value: any = 1;\n');
    const plan = planReviewBundles(['src/a.ts'], root, DEFAULT_REVIEW_POLICY);
    writeFileSync(join(root, 'src', 'a.ts'), 'const value: any = 2;\n');
    const [finding] = validateFindingPositions(
      [
        {
          fingerprint: 'stale',
          rule: 'explicit-any',
          severity: 'medium',
          file: 'src/a.ts',
          line: 1,
          message: 'stale source',
        },
      ],
      plan,
      root,
    );
    expect(finding?.status).toBe('unverifiable');
    expect(finding?.nextAction).toContain('source changed');
  });

  it('rejects policy additions that could silently weaken the contract', () => {
    expect(() => parseReviewPolicy({ ...DEFAULT_REVIEW_POLICY, unknown: true })).toThrow(
      /Invalid review policy/,
    );
  });

  it('executes repository-specific literal rules instead of accepting dead policy fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-review-custom-rule-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'legacyApi();\n', 'utf8');
    const policy = parseReviewPolicy({
      ...DEFAULT_REVIEW_POLICY,
      rules: [
        {
          id: 'legacy-api',
          severity: 'medium',
          message: 'Legacy API call needs review.',
          contains: 'legacyApi(',
        },
      ],
    });
    expect(collectReviewFindings(['src/a.ts'], root, policy)).toHaveLength(1);
    expect(() =>
      parseReviewPolicy({
        ...DEFAULT_REVIEW_POLICY,
        rules: [{ ...policy.rules[0], contains: undefined }],
      }),
    ).toThrow(/no executable matcher/);
  });

  it('uses the versioned policy rules as the single finding-generation source', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-review-policy-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'const value: any = 1;\nconsole.log(value);\n');
    const policy = parseReviewPolicy({
      ...DEFAULT_REVIEW_POLICY,
      rules: DEFAULT_REVIEW_POLICY.rules.map((rule) =>
        rule.id === 'explicit-any' ? { ...rule, enabled: false } : rule,
      ),
    });
    const findings = collectReviewFindings(['src/a.ts'], root, policy);
    expect(findings.some((finding) => finding.rule === 'explicit-any')).toBe(false);
    expect(findings.some((finding) => finding.rule === 'console-output')).toBe(true);
  });

  it('does not publish a source-backed finding below its policy confidence threshold', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-review-confidence-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'const value: any = 1;\n');
    const plan = planReviewBundles(['src/a.ts'], root, DEFAULT_REVIEW_POLICY);
    const [finding] = validateFindingPositions(
      [
        {
          fingerprint: 'low-confidence',
          rule: 'explicit-any',
          severity: 'medium',
          file: 'src/a.ts',
          line: 1,
          message: 'weak claim',
          confidence: 0.1,
        },
      ],
      plan,
      root,
    );
    const reflected = reflectFindings([finding!], DEFAULT_REVIEW_POLICY, root);
    expect(reflected[0]?.status).toBe('unsupported');
    expect(verifiedFindings(reflected)).toHaveLength(0);
  });
});
