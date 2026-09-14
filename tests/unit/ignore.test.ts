import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PMIGNORE_CONTENT,
  DEFAULT_PMIGNORE_PATTERNS,
  getProjectIgnorePatterns,
  isIgnoredRelativePath,
  readPmignore,
} from '@/utils/ignore.js';

describe('ProjectMind ignore policy', () => {
  it('keeps generated .pmignore content aligned with built-in generated paths', () => {
    expect(DEFAULT_PMIGNORE_CONTENT).toContain('.next/');
    expect(DEFAULT_PMIGNORE_CONTENT).toContain('.turbo/');
    expect(DEFAULT_PMIGNORE_CONTENT).toContain('.idea/');

    const root = mkdtempSync(join(process.env.TEMP ?? '.', 'projectmind-ignore-'));
    try {
      writeFileSync(join(root, '.pmignore'), DEFAULT_PMIGNORE_CONTENT, 'utf8');
      const filePatterns = readPmignore(root);
      const allPatterns = getProjectIgnorePatterns(root);

      expect(filePatterns.length).toBeGreaterThan(0);
      for (const path of ['.next/cache/file', '.turbo/cache/file', '.idea/workspace.xml']) {
        expect(isIgnoredRelativePath(path, filePatterns)).toBe(true);
        expect(isIgnoredRelativePath(path.replaceAll('/', '\\'), allPatterns)).toBe(true);
      }
      expect(DEFAULT_PMIGNORE_PATTERNS).toContain('.next/**');
      expect(DEFAULT_PMIGNORE_PATTERNS).toContain('.turbo/**');
      expect(DEFAULT_PMIGNORE_PATTERNS).toContain('.idea/**');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('normalizes Windows and POSIX separators consistently', () => {
    const patterns = ['**/generated/**', '**/cache/*.json'];
    expect(isIgnoredRelativePath('src\\generated\\snapshot.ts', patterns)).toBe(true);
    expect(isIgnoredRelativePath('src/cache/result.json', patterns)).toBe(true);
    expect(isIgnoredRelativePath('src/cache/result.txt', patterns)).toBe(false);
  });
});
