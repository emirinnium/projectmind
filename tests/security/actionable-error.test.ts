import { describe, expect, it } from 'vitest';
import { actionableError, toActionableError } from '../../src/utils/actionable-error.js';
import { PathSecurityError } from '../../src/core/security/path-security.js';

describe('actionable public error contract', () => {
  it('serializes stable machine fields and next actions', () => {
    const problem = toActionableError(
      actionableError(
        'review.invalid-policy',
        'Policy is invalid.',
        ['Fix the policy and retry.'],
        {
          cause: 'validation',
          retryable: true,
        },
      ),
    );
    expect(problem).toMatchObject({
      code: 'review.invalid-policy',
      summary: 'Policy is invalid.',
      cause: 'validation',
      retryable: true,
      destructive: false,
      networkRequired: false,
    });
    expect(problem.nextActions).toEqual(['Fix the policy and retry.']);
  });

  it('redacts absolute roots from path error summaries', () => {
    const problem = toActionableError(
      new PathSecurityError('outside-project', '../secret.ts', 'C:/private/project', 'retry'),
    );
    expect(problem.code).toBe('path.outside-project');
    expect(problem.summary).toBe('The path escapes the configured project root.');
    expect(JSON.stringify(problem)).not.toContain('C:/private/project');
    expect(problem.nextActions[0]).toContain('PROJECTMIND_ROOT');
  });
});
