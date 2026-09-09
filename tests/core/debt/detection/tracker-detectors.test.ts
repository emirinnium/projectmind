import { describe, expect, it } from 'vitest';
import { analyzeTechnicalDebt } from '../../../../src/core/debt/tracker-detectors.js';
import type { GitChurnEntry } from '../../../../src/core/debt/git-churn.js';

describe('technical debt detector evidence', () => {
  it('keeps each finding trace specific to its detector', () => {
    const sourceCode = 'export const value = 1;\n';
    const churn: GitChurnEntry = {
      path: 'src/example.ts',
      count: 12,
      authors: new Set(['a', 'b']),
    };
    const findings = analyzeTechnicalDebt(
      {
        path: 'C:/project/src/example.ts',
        relativePath: 'src/example.ts',
        lastModified: '2020-01-01T00:00:00.000Z',
        cognitiveLoad: 0.5,
      },
      sourceCode,
      new Map([[churn.path, churn]]),
    );

    const types = findings.map((finding) => finding.type);
    expect(types).toEqual(expect.arrayContaining(['code_age', 'cognitive_load', 'change_frequency']));
    for (const finding of findings) {
      expect(finding.reasoningTrace).toHaveLength(1);
      expect(finding.reasoningTrace[0]).toContain(
        finding.type === 'code_age'
          ? 'old'
          : finding.type === 'cognitive_load'
            ? 'cognitive load'
            : 'changed',
      );
    }
    expect(findings.find((finding) => finding.type === 'code_age')?.reasoningTrace).not.toContain(
      expect.stringContaining('cyclomatic'),
    );
  });
});
