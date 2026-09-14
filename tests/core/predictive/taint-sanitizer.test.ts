import { describe, expect, it } from 'vitest';
import { TaintAnalyzer } from '@/parser/taint-analyzer.js';
import { buildExploitPathReport } from '@/core/predictive/exploit-path.js';

describe('taint sanitizer evidence', () => {
  it('keeps a sanitized source-to-sink path visible and marks its sanitizer step', () => {
    const source = [
      'const raw = fs.readFileSync(input);',
      'const clean = escape(raw);',
      'writeFileSync(output, clean);',
    ].join('\n');
    const analyzer = new TaintAnalyzer({} as never);
    const flows = analyzer.analyzeSource('/fixture/security.ts', source, 'typescript');
    const report = buildExploitPathReport('src/security.ts', flows);

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]?.sanitizedByKnownFunction).toBe(true);
    expect(report.candidates[0]?.steps.map((step) => step.type)).toContain('sanitizer');
    expect(report.candidates[0]?.safeReproduction.reason).toContain('sanitizer');
    expect(report.candidates[0]?.vulnerabilityProven).toBe(false);
  });

  it('does not mark an unsanitized flow as sanitized', () => {
    const source = ['const raw = fs.readFileSync(input);', 'writeFileSync(output, raw);'].join(
      '\n',
    );
    const flows = new TaintAnalyzer({} as never).analyzeSource(
      '/fixture/security.ts',
      source,
      'typescript',
    );
    const report = buildExploitPathReport('src/security.ts', flows);
    expect(report.candidates[0]?.sanitizedByKnownFunction).toBe(false);
  });
});
