import { describe, expect, it } from 'vitest';
import { isTestFile } from '../../src/cli/commands/audit.js';

describe('audit file scope', () => {
  it('recognizes test directories and test/spec suffixes on both path styles', () => {
    expect(isTestFile('tests/unit/auth.test.ts')).toBe(true);
    expect(isTestFile('tests\\unit\\auth.spec.ts')).toBe(true);
    expect(isTestFile('src/feature/__tests__/auth.ts')).toBe(true);
    expect(isTestFile('src/feature/auth.test.tsx')).toBe(true);
  });

  it('keeps production source files in the default audit scope', () => {
    expect(isTestFile('src/auth/registry.ts')).toBe(false);
    expect(isTestFile('src/auth/registry.js')).toBe(false);
    expect(isTestFile('src/testimony.ts')).toBe(false);
  });
});
