import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSymbolReferencesForTool } from '../../../src/mcp/tools/symbol-refs.js';
import type { McpDependencies } from '../../../src/mcp/tools/types.js';

/**
 * Minimal McpDependencies stub — findSymbolReferencesForTool only relies on
 * `projectRoot`, so the rest of the surface is left as a partial cast.
 */
function makeDeps(projectRoot: string): McpDependencies {
  return { projectRoot } as McpDependencies;
}

/**
 * Seed a real temp TypeScript project: a minimal tsconfig.json plus a source
 * file that declares `counter` and references it (a write in the increment
 * and a read in the return). The language service resolves through the real
 * filesystem, so the declaration (isWriteAccess true) and the read reference
 * (isWriteAccess false) must both be found.
 */
async function seedProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pm-symbol-refs-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true },
      include: ['src/**/*.ts'],
    }),
    'utf-8'
  );
  await writeFile(
    join(root, 'src', 'counter.ts'),
    [
      'let counter = 0;',
      'export function increment(): number {',
      '  counter = counter + 1;',
      '  return counter;',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );
  return root;
}

describe('find_symbol_references (findSymbolReferencesForTool)', () => {
  const tmpRoots: string[] = [];

  afterAll(async () => {
    await Promise.all(tmpRoots.map((r) => rm(r, { recursive: true, force: true })));
  });

  it('returns the declaration (write) and the read reference with correct file:line', async () => {
    const root = await seedProject();
    tmpRoots.push(root);

    const result = findSymbolReferencesForTool(makeDeps(root), {
      file: 'src/counter.ts',
      symbol: 'counter',
    });

    expect(result.symbol).toBe('counter');
    expect(result.total).toBeGreaterThanOrEqual(2);

    // The declaration `let counter = 0;` is on line 1 and is a write access.
    const decl = result.references.find((r) => r.line === 1);
    expect(decl).toBeDefined();
    expect(decl).toMatchObject({
      file: expect.stringContaining('src/counter.ts'),
      line: 1,
      isWriteAccess: true,
    });
    expect(decl!.snippet).toContain('counter');

    // The read `return counter;` is on line 4 and is NOT a write access.
    const read = result.references.find((r) => r.line === 4);
    expect(read).toBeDefined();
    expect(read).toMatchObject({
      line: 4,
      isWriteAccess: false,
    });
    expect(read!.snippet).toContain('counter');
  });

  it('respects the max cap on returned references', async () => {
    const root = await seedProject();
    tmpRoots.push(root);

    const result = findSymbolReferencesForTool(makeDeps(root), {
      file: 'src/counter.ts',
      symbol: 'counter',
      max: 1,
    });

    expect(result.references.length).toBeLessThanOrEqual(1);
    expect(result.total).toBeGreaterThanOrEqual(2);
  });

  it('throws a clear error when the symbol is not found', async () => {
    const root = await seedProject();
    tmpRoots.push(root);

    expect(() =>
      findSymbolReferencesForTool(makeDeps(root), {
        file: 'src/counter.ts',
        symbol: 'doesNotExist',
      })
    ).toThrow(/not found as a whole word/i);
  });

  it('throws a clear error when the project has no tsconfig.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-symbol-refs-notsconfig-'));
    tmpRoots.push(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'counter.ts'), 'let counter = 0;\n', 'utf-8');

    expect(() =>
      findSymbolReferencesForTool(makeDeps(root), {
        file: 'src/counter.ts',
        symbol: 'counter',
      })
    ).toThrow(/no usable tsconfig/i);
  });

  it('rejects a file path that escapes the project root', async () => {
    const root = await seedProject();
    tmpRoots.push(root);

    expect(() =>
      findSymbolReferencesForTool(makeDeps(root), {
        file: '../outside.ts',
        symbol: 'counter',
      })
    ).toThrow(/escapes project root/i);
  });
});
