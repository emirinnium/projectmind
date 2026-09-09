import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateProjectPath } from '../../src/core/security/path-security.js';

describe('bounded path/config property checks', () => {
  it('normalizing an accepted path twice is stable across separator spellings', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-path-property-'));
    mkdirSync(join(root, 'src', 'nested'), { recursive: true });
    writeFileSync(join(root, 'src', 'nested', 'file.ts'), 'export const file = true;\n', 'utf8');
    const variants = ['src/nested/file.ts', 'src\\nested\\file.ts', './src/nested/file.ts'];
    for (const variant of variants) {
      const first = validateProjectPath(variant, root, { mustExist: true });
      const second = validateProjectPath(first.relativePath, root, { mustExist: true });
      expect(second.relativePath).toBe(first.relativePath);
      expect(second.absolutePath).toBe(first.absolutePath);
    }
  });

  it('rejects a bounded malformed-input corpus without touching the filesystem', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-path-property-'));
    const malformed = ['', '\0', 'src/\u0001file.ts', '../outside', 'C:\\outside\\file.ts'];
    for (const value of malformed) expect(() => validateProjectPath(value, root)).toThrow();
  });
});
