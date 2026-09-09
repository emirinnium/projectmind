import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProjectRoot } from '../../../src/core/project/roots.js';

describe('project root resolution', () => {
  it('returns the canonical existing directory and rejects files', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-root-'));
    mkdirSync(join(root, 'nested'));
    expect(resolveProjectRoot('nested', root)).toBe(join(root, 'nested'));
    expect(() => resolveProjectRoot('missing', root)).toThrow();
  });
});
