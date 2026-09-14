import { describe, expect, it } from 'vitest';
import { renderTextChurn } from '../../src/cli/commands/churn.js';

describe('churn text output', () => {
  it('renders human-readable text instead of JSON', () => {
    const report = renderTextChurn(
      [
        {
          path: 'src/auth.ts',
          churnCount: 4,
          cognitiveLoad: 0.2,
          riskScore: 0.22,
          authors: ['emir'],
        },
      ],
      [],
      0.7,
      'file',
    );

    expect(report).toContain('Code Churn & Risk Analysis');
    expect(report).toContain('src/auth.ts');
    expect(report).not.toContain('"churnData"');
    expect(report.trimStart()).not.toMatch(/^\{/);
  });
});
