import { describe, expect, it } from 'vitest';
import { generateOnboardingPath } from '../../src/cli/commands/onboard-utils.js';

describe('onboarding workflow', () => {
  it('includes an evidence-first workflow at medium depth', () => {
    const path = generateOnboardingPath('fullstack', 2, { modules: [] }, [
      { relativePath: '.pmignore' },
      { relativePath: 'src/core/proof/evidence.ts' },
      { relativePath: 'src/core/ledger/evidence-ledger.ts' },
    ]);
    const step = path.steps.find(
      (candidate) => candidate.title === 'Evidence-First Agent Workflow',
    );
    expect(step).toMatchObject({ type: 'run', estimatedTime: '25 min' });
    expect(step?.files).toEqual(['.pmignore', 'src/core/proof/', 'src/core/ledger/']);
    expect(step?.description).toMatch(/freshness|unverified/i);
  });
});
