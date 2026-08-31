import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSymbolDefinitionForTool } from '../../../src/mcp/tools/symbol-def.js';
import type { McpDependencies } from '../../../src/mcp/tools/types.js';

/**
 * Minimal McpDependencies stub — findSymbolDefinitionForTool only relies on
 * `projectRoot` and the language service, so the rest of the surface is left
 * as a partial cast.
 */
function makeDeps(projectRoot: string): McpDependencies {
  return { projectRoot } as McpDependencies;
}

/**
 * Seed a real temp TypeScript project: a minimal tsconfig.json plus source
 * files that declare various symbols (function, class, const, type, enum)
 * and reference them. The language service resolves through the real
 * filesystem, so definitions are found correctly.
 */
async function seedProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pm-symbol-def-'));
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
    join(root, 'src', 'utils.ts'),
    [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
      'export class MathUtils {',
      '  static multiply(a: number, b: number): number {',
      '    return a * b;',
      '  }',
      '}',
      '',
      'export const PI = 3.14159;',
      '',
      'export type Config = {',
      '  readonly port: number;',
      '  readonly host: string;',
      '}',
      '',
      'export enum Status {',
      '  Active = "active",',
      '  Inactive = "inactive"',
      '}',
    ].join('\n'),
    'utf-8'
  );
  await writeFile(
    join(root, 'src', 'main.ts'),
    [
      'import { add, PI, MathUtils, Status } from "./utils";',
      '',
      'const result = add(2, 3);',
      'const area = MathUtils.multiply(2, 3);',
      'const status: Status = Status.Active;',
      'const config: Config = { port: 8080, host: "localhost" };',
      '',
      'console.log("Result:", add(2, 3));',
      'console.log("PI:", PI);',
      'console.log("Status:", Status.Active);',
    ].join('\n'),
    'utf-8'
  );
  return root;
}

describe('find_symbol_definition (findSymbolDefinitionForTool)', () => {
  const tmpRoots: string[] = [];

  afterAll(async () => {
    await Promise.all(tmpRoots.map((r) => rm(r, { recursive: true, force: true })));
  });

  it('finds the definition of a function symbol', async () => {
    const root = await seedProject();
    tmpRoots.push(root);

    const result = findSymbolDefinitionForTool(makeDeps(root), {
      file: 'src/utils.ts',
      symbol: 'add',
    });

    expect(result.definition).not.toBeNull();
    expect(result.definition!.file).toContain('src/utils.ts');
    expect(result.definition!.line).toBeGreaterThan(0);
    expect(result.definition!.column).toBeGreaterThan(0);
    expect(result.definition!.name).toBe('add');
    expect(result.definition!.kind).toBe('function');
  });

  it('finds the definition of a class symbol', async () => {
    const root = await seedProject();
    tmpRoots.push(root);

    const result = findSymbolDefinitionForTool(makeDeps(root), {
      file: 'src/utils.ts',
      symbol: 'MathUtils',
    });

    expect(result.definition).not.toBeNull();
    expect(result.definition!.name).toBe('MathUtils');
    expect(result.definition!.kind).toBe('class');
  });

  it('finds the definition of a const symbol', async () => {
    const root = await seedProject();
    tmpRoots.push(root);

    const result = findSymbolDefinitionForTool(makeDeps(root), {
      file: 'src/utils.ts',
      symbol: 'PI',
    });

    expect(result.definition).not.toBeNull();
    expect(result.definition!.name).toBe('PI');
    expect(result.definition!.kind).toBe('const');
  });

  it('finds the definition of a type symbol', async () => {
    const root = await seedProject();
    tmpRoots.push(root);

    const result = findSymbolDefinitionForTool(makeDeps(root), {
      file: 'src/utils.ts',
      symbol: 'Config',
    });

    expect(result.definition).not.toBeNull();
    expect(result.definition!.name).toBe('Config');
    expect(result.definition!.kind).toBe('type');
  });

  it('finds the definition of an enum symbol', async () => {
    const root = await seedProject();
    tmpRoots.push(root);

    const result = findSymbolDefinitionForTool(makeDeps(root), {
      file: 'src/utils.ts',
      symbol: 'Status',
    });

    expect(result.definition).not.toBeNull();
    expect(result.definition!.name).toBe('Status');
    expect(result.definition!.kind).toBe('enum');
  });

  it('returns null definition when symbol is not found in the file', async () => {
    const root = await seedProject();
    tmpRoots.push(root);

    const result = findSymbolDefinitionForTool(makeDeps(root), {
      file: 'src/utils.ts',
      symbol: 'nonexistent',
    });

    expect(result.definition).toBeNull();
  });

  it('returns null definition when project has no tsconfig.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-symbol-def-notsconfig-'));
    tmpRoots.push(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'utils.ts'), 'export function foo() {}\n', 'utf-8');

    const result = findSymbolDefinitionForTool(makeDeps(root), {
      file: 'src/utils.ts',
      symbol: 'foo',
    });

    expect(result.definition).toBeNull();
  });

  it('confines file paths to the project root', async () => {
    const root = await seedProject();
    tmpRoots.push(root);

    const result = findSymbolDefinitionForTool(makeDeps(root), {
      file: '../outside.ts',
      symbol: 'add',
    });

    // Should still return a result (the tool doesn't throw, it gracefully handles)
    // but the definition should be null since the file is outside the project
    expect(result.definition).toBeNull();
  });

  it('handles file path that escapes project root gracefully', async () => {
    const root = await seedProject();
    tmpRoots.push(root);

    // This should not throw - the tool confines paths internally
    const result = findSymbolDefinitionForTool(makeDeps(root), {
      file: '../outside.ts',
      symbol: 'add',
    });

    // Definition should be null for out-of-project files
    expect(result.definition).toBeNull();
  });
});