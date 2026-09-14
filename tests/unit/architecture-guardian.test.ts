import { describe, expect, it } from 'vitest';
import { ArchitectureGuardian } from '../../src/core/architecture/guardian.js';

describe('ArchitectureGuardian', () => {
  const contract = {
    id: 'no-eval',
    name: 'No eval',
    sourcePattern: '**/*.ts',
    forbiddenKeywords: ['eval\\s*\\('],
    severity: 'error' as const,
  };

  it('reports violations without blocking by default', () => {
    const result = new ArchitectureGuardian([contract]).inspect('src/a.ts', 'eval(input);');

    expect(result.allowed).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.line).toBe(1);
  });

  it('blocks only when explicitly enabled', () => {
    const result = new ArchitectureGuardian([contract], true).inspect('src/a.ts', 'eval(input);');

    expect(result.allowed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.nextActions.length).toBeGreaterThan(0);
  });
});
