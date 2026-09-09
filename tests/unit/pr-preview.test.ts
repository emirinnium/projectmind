import { describe, expect, it } from 'vitest';
import {
  generateSarifPrPreview,
  validateGitRevision,
  type PrImpact,
} from '../../src/cli/commands/pr-preview.js';

describe('PR preview input boundaries', () => {
  it.each(['main', 'origin/main', 'HEAD', 'HEAD~1', 'refs/pull/42/head'])(
    'accepts a normal Git revision: %s',
    (revision) => {
      expect(validateGitRevision(revision, 'base')).toBe(revision);
    },
  );

  it.each(['--output=outside.txt', ' main', 'main ', 'main\nother', ''])(
    'rejects option-looking or control-containing revision: %j',
    (revision) => {
      expect(() => validateGitRevision(revision, 'head')).toThrow(/Invalid head Git revision/);
    },
  );

  it('rejects an excessively long revision before Git is invoked', () => {
    expect(() => validateGitRevision('a'.repeat(257), 'base')).toThrow(/Invalid base Git revision/);
  });

  it('emits SARIF 2.1.0 with actionable locations and stable fingerprints', () => {
    const impact: PrImpact = {
      baseRef: 'main',
      headRef: 'HEAD',
      changedFiles: ['src/auth.ts'],
      affectedModules: [],
      coherenceRisk: 'high',
      testSelection: [],
      estimatedReviewTime: 10,
      breakingChanges: ['Core types/exports changed: src/auth.ts'],
      coherenceIssues: [{ file: 'src/auth.ts', verdict: 'warn', issues: ['Review export shape'] }],
      findings: [
        {
          fingerprint: 'stable-fingerprint',
          rule: 'explicit-any',
          severity: 'medium',
          file: 'src/auth.ts',
          line: 12,
          message: 'Explicit any weakens the static contract at a changed line.',
        },
      ],
      reviewerConsensus: {
        reviewers: [],
        consolidatedFindingCount: 3,
      },
    };

    const sarif = JSON.parse(generateSarifPrPreview(impact)) as {
      version: string;
      runs: Array<{
        results: Array<{
          ruleId: string;
          locations?: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
          partialFingerprints: { primaryLocationLineHash: string };
        }>;
      }>;
    };
    const results = sarif.runs[0]?.results ?? [];
    expect(sarif.version).toBe('2.1.0');
    expect(results.map((result) => result.ruleId)).toEqual([
      'explicit-any',
      'coherence-warn',
      'potential-breaking-change',
    ]);
    expect(results[0]?.locations?.[0]?.physicalLocation.artifactLocation.uri).toBe('src/auth.ts');
    expect(results[0]?.partialFingerprints.primaryLocationLineHash).toBe('stable-fingerprint');
  });
});
