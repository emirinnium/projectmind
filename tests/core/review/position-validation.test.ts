import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planReviewBundles } from '../../../src/core/review/bundle.js';
import { validateFindingPositions } from '../../../src/core/review/finding-validation.js';
import { DEFAULT_REVIEW_POLICY } from '../../../src/core/review/policy.js';

describe('independent review position validation', () => {
  it('quarantines a valid source finding when its line is outside the changed hunk', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-position-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'const old = 1;\nconst value: any = 2;\n');
    const plan = planReviewBundles(['src/a.ts'], root, DEFAULT_REVIEW_POLICY, {
      allowedLineRanges: { 'src/a.ts': [[1, 1]] },
    });
    const [finding] = validateFindingPositions(
      [
        {
          fingerprint: 'f',
          rule: 'explicit-any',
          severity: 'medium',
          file: 'src/a.ts',
          line: 2,
          message: 'any',
        },
      ],
      plan,
      root,
    );
    expect(finding?.status).toBe('position-drift');
    expect(finding?.nextAction).toContain('changed-line');
  });
});
