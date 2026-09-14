import { describe, expect, it } from 'vitest';
import { evaluateSecurityRegression } from '../../scripts/benchmark/security-regression.mjs';

const baseline = {
  manifestName: 'fixture-security',
  inputHash: 'security-hash',
  verifiedRepositories: 1,
  filesScanned: 4,
  filesSkipped: 2,
  candidateFindings: 3,
  bySeverity: { critical: 0, high: 2, medium: 1 },
};

function result(overrides: Record<string, unknown> = {}) {
  return {
    manifest: { name: 'fixture-security', inputHash: 'security-hash' },
    verifiedRepositories: 1,
    filesScanned: 4,
    filesSkipped: 2,
    candidateFindings: 3,
    bySeverity: { critical: 0, high: 2, medium: 1 },
    ...overrides,
  };
}

describe('internal security regression gate', () => {
  it('passes unchanged static candidate evidence', () => {
    expect(evaluateSecurityRegression(result(), baseline).passed).toBe(true);
  });

  it('fails closed on corpus drift and candidate-count changes', () => {
    const gate = evaluateSecurityRegression(
      result({
        manifest: { name: 'fixture-security', inputHash: 'changed' },
        candidateFindings: 2,
        bySeverity: { critical: 0, high: 1, medium: 1 },
      }),
      baseline,
    );
    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('input hash');
    expect(gate.failures.join(' ')).toContain('candidate findings');
    expect(gate.failures.join(' ')).toContain('high candidate count');
  });

  it('fails when a repository was not verified', () => {
    const gate = evaluateSecurityRegression(result({ verifiedRepositories: 0 }), baseline);
    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('verified repositories');
  });
});
