import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertProjectPath,
  PathSecurityError,
  validateProjectPath,
} from '../../src/core/security/path-security.js';

describe('central path-security contract', () => {
  it('accepts project-relative files and returns normalized metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-path-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;');
    const result = validateProjectPath('src\\a.ts', root, { mustExist: true });
    expect(result.relativePath).toBe('src/a.ts');
    expect(result.exists).toBe(true);
  });

  it.each(['../outside.ts', '/etc/passwd', 'C:\\Windows\\System32\\drivers\\etc\\hosts', '\0bad'])(
    'rejects unsafe path %s',
    (value) => {
      const root = mkdtempSync(join(tmpdir(), 'projectmind-path-'));
      expect(() => assertProjectPath(value, root)).toThrow(PathSecurityError);
    },
  );

  it('rejects ignored files when a reader opts into the source policy', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-path-'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'dep.ts'), 'export const dep = 1;');
    expect(() =>
      assertProjectPath('node_modules/dep.ts', root, { mustExist: true, rejectIgnored: true }),
    ).toThrow(/ignored-path/);
  });

  it('rejects an output file whose existing ancestor is an escaping symlink when supported', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-path-'));
    const outside = mkdtempSync(join(tmpdir(), 'projectmind-outside-'));
    try {
      symlinkSync(outside, join(root, 'linked'), 'junction');
      expect(() => assertProjectPath('linked/result.json', root)).toThrow(
        /symlink-outside-project/,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        /EPERM|operation not permitted|not supported/i.test(error.message)
      )
        return;
      throw error;
    }
  });
});
