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

  it('classifies legacy stale-index errors with a concrete recovery action', () => {
    expect(toActionableError(new Error('Indexed source is stale; rescan required.'))).toMatchObject(
      {
        cause: 'stale-index',
        retryable: true,
        nextActions: ['Run pm scan --incremental, then retry the command.'],
      },
    );
  });

  it('classifies provider/network failures without treating them as generic runtime errors', () => {
    expect(toActionableError(new Error('Provider request timed out after 30000ms.'))).toMatchObject(
      {
        cause: 'network',
        networkRequired: true,
        retryable: true,
      },
    );
  });

  it('explains how to recover from a locked SQLite/file target', () => {
    expect(toActionableError(new Error('EBUSY: resource busy or locked'))).toMatchObject({
      cause: 'filesystem',
      retryable: true,
      nextActions: [
        'Close other ProjectMind/MCP processes using this project, then retry the operation.',
      ],
    });
  });

  it('classifies malformed tool arguments as validation failures', () => {
    expect(toActionableError(new Error('limit must be between 1 and 50.'))).toMatchObject({
      cause: 'validation',
      retryable: true,
      nextActions: ['Correct the reported input and retry.'],
    });
  });

  it('preserves actionable advisory URLs while sanitizing local paths', () => {
    const problem = toActionableError(
      actionableError(
        'dependency.audit',
        'See https://github.com/advisories/GHSA-test and C:\\Users\\secret\\repo\\file.ts:12.',
        ['Open https://github.com/advisories/GHSA-test for the remediation.'],
      ),
    );
    expect(problem.summary).toContain('https://github.com/advisories/GHSA-test');
    expect(problem.summary).toContain('[path]');
    expect(problem.nextActions[0]).toContain('https://github.com/advisories/GHSA-test');
  });
});
