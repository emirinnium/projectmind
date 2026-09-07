import { describe, it, expect } from 'vitest';
import { detectLanguageFromPath } from '../../src/parser/language-service.js';

describe('language-service - detectLanguageFromPath', () => {
  it('detects JavaScript and TypeScript extensions', () => {
    expect(detectLanguageFromPath('a.ts')).toBe('typescript');
    expect(detectLanguageFromPath('a.tsx')).toBe('typescript');
    expect(detectLanguageFromPath('a.js')).toBe('javascript');
    expect(detectLanguageFromPath('a.jsx')).toBe('javascript');
    expect(detectLanguageFromPath('a.mjs')).toBe('javascript');
    expect(detectLanguageFromPath('a.cjs')).toBe('javascript');
  });

  it('returns null for unsupported extensions', () => {
    expect(detectLanguageFromPath('a.txt')).toBeNull();
    expect(detectLanguageFromPath('a.md')).toBeNull();
  });
});
