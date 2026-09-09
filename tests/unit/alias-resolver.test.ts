import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AliasResolver } from '../../src/parser/alias-resolver.js';

describe('AliasResolver', () => {
  it('maps emitted JavaScript specifiers to TypeScript source files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-alias-'));
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(
        join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }),
        'utf8',
      );
      await writeFile(join(root, 'src', 'utils.ts'), 'export const value = 1;\n', 'utf8');

      const resolver = new AliasResolver(root);
      expect(resolver.resolveAliasToPath('@/utils.js')).toBe('src/utils.ts');
      expect(resolver.resolveAliasToPath('@/utils')).toBe('src/utils.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('distinguishes local relative/alias imports from external and builtin imports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-alias-scope-'));
    try {
      await writeFile(
        join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }),
        'utf8',
      );
      const resolver = new AliasResolver(root);

      expect(resolver.isProjectLocalSource('./utils.js')).toBe(true);
      expect(resolver.isProjectLocalSource('@/utils.js')).toBe(true);
      expect(resolver.isProjectLocalSource('node:fs')).toBe(false);
      expect(resolver.isProjectLocalSource('commander')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
