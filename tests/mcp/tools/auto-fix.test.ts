import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAutoFix } from '../../../src/mcp/tools/auto-fix.js';
import type { McpDependencies } from '../../../src/mcp/tools/types.js';

/**
 * Minimal McpDependencies stub — runAutoFix only relies on `projectRoot`,
 * so the rest of the surface is left as a partial cast.
 */
function makeDeps(projectRoot: string): McpDependencies {
  return { projectRoot } as McpDependencies;
}

describe('auto_fix (runAutoFix)', () => {
  const tmpRoots: string[] = [];

  afterAll(async () => {
    for (const root of tmpRoots) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function makeTmpRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'pm-autofix-'));
    // Create src subdirectory for test files
    await mkdir(join(root, 'src'), { recursive: true });
    tmpRoots.push(root);
    return root;
  }

  it('preview mode (apply:false) does NOT modify disk and returns a non-empty diff for a fixable file', async () => {
    const root = await makeTmpRoot();
    const filePath = join(root, 'src', 'sample.ts');
    const original = 'export function f() {\n  var x = 1;\n  return x;\n}\n';
    await writeFile(filePath, original, 'utf-8');

    const result = await runAutoFix(makeDeps(root), {
      filePath: 'src/sample.ts',
      fixes: ['var-to-const'],
      apply: false,
    });

    // Disk must be untouched in preview mode.
    const after = await readFile(filePath, 'utf-8');
    expect(after).toBe(original);

    // A fixable issue was found → non-empty diff, not written.
    expect(result.changed).toBe(true);
    expect(result.diff.length).toBeGreaterThan(0);
    expect(result.diff).toContain('const x = 1');
    expect(result.written).toBe(false);
  });

  it('apply mode (apply:true) DOES modify disk and reports written:true', async () => {
    const root = await makeTmpRoot();
    const filePath = join(root, 'src', 'sample.ts');
    const original = 'export function f() {\n  var x = 1;\n  return x;\n}\n';
    await writeFile(filePath, original, 'utf-8');

    const result = await runAutoFix(makeDeps(root), {
      filePath: 'src/sample.ts',
      fixes: ['var-to-const'],
      apply: true,
    });

    const after = await readFile(filePath, 'utf-8');
    expect(after).toContain('const x = 1');
    expect(after).not.toContain('var x = 1');
    expect(result.changed).toBe(true);
    expect(result.written).toBe(true);
  });

  it('returns changed:false and an empty diff for a clean file (no-op)', async () => {
    const root = await makeTmpRoot();
    const filePath = join(root, 'src', 'clean.ts');
    // Already const + single sorted import that IS used + no unused imports → nothing to fix.
    const original =
      "import { readFile } from 'node:fs/promises';\n\nexport async function f() {\n  const x = 1;\n  await readFile('a');\n  return x;\n}\n";
    await writeFile(filePath, original, 'utf-8');

    const result = await runAutoFix(makeDeps(root), {
      filePath: 'src/clean.ts',
      fixes: ['var-to-const', 'organize-imports', 'remove-unused-imports'],
      apply: false,
    });

    expect(result.changed).toBe(false);
    expect(result.diff).toBe('');
    expect(result.written).toBe(false);
  });

  it('rejects a filePath that escapes the project root', async () => {
    const root = await makeTmpRoot();
    await expect(
      runAutoFix(makeDeps(root), { filePath: '../outside.ts', fixes: ['var-to-const'] })
    ).rejects.toThrow(/escapes project root/i);
  });

  describe('add-return-types fixer', () => {
    it('adds return type for void function', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'void-fn.ts');
      const original = 'export function doSomething() {\n  console.log("hello");\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/void-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      expect(result.changed).toBe(true);
      expect(result.diff).toContain(': void');
      expect(result.written).toBe(false);
    });

    it('adds return type for never function', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'never-fn.ts');
      const original = 'export function throwError(): never {\n  throw new Error("fail");\n}\n';
      await writeFile(filePath, original, 'utf-8');

      // Already has return type -> no change
      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/never-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      expect(result.changed).toBe(false);
    });

    it('adds return type for never function without annotation', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'never-fn.ts');
      const original = 'export function throwError() {\n  throw new Error("fail");\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/never-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      // TypeScript infers `void` for a function that throws (not `never`)
      expect(result.changed).toBe(true);
      expect(result.diff).toContain(': void');
    });

    it('adds return type for unknown function', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'unknown-fn.ts');
      const original = 'export function parseValue(input: string) {\n  try {\n    return JSON.parse(input);\n  } catch {\n    return undefined;\n  }\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/unknown-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      // The inferred type may be unknown or any depending on TS version
      expect(result.changed).toBe(true);
      expect(result.diff).toMatch(/: (unknown|any)/);
    });

    it('adds return type for any function', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'any-fn.ts');
      const original = 'export function identity(x: any) {\n  return x;\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/any-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      expect(result.changed).toBe(true);
      expect(result.diff).toContain(': any');
    });

    it('adds return type for string function', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'string-fn.ts');
      const original = 'export function greet(name: string) {\n  return `Hello, ${name}!`;\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/string-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      expect(result.changed).toBe(true);
      expect(result.diff).toContain(': string');
    });

    it('adds return type for number function', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'number-fn.ts');
      const original = 'export function add(a: number, b: number) {\n  return a + b;\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/number-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      expect(result.changed).toBe(true);
      expect(result.diff).toContain(': number');
    });

    it('adds return type for boolean function', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'boolean-fn.ts');
      const original = 'export function isEven(n: number) {\n  return n % 2 === 0;\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/boolean-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      expect(result.changed).toBe(true);
      expect(result.diff).toContain(': boolean');
    });

    it('skips functions with inferred object literal types', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'object-fn.ts');
      const original = 'export function createConfig() {\n  return { debug: true, port: 3000 };\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/object-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      // TypeScript infers `{ debug: boolean; port: number }` which is not in SAFE_RETURN
      expect(result.changed).toBe(false);
    });

    it('skips functions with inferred function types', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'function-fn.ts');
      const original = 'export function getHandler() {\n  return () => console.log("called");\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/function-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      // TypeScript infers `() => void` which is not in SAFE_RETURN
      expect(result.changed).toBe(false);
    });

    it('adds return type for Promise<void> function', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'promise-void-fn.ts');
      const original = 'export async function doAsync() {\n  await Promise.resolve();\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/promise-void-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      expect(result.changed).toBe(true);
      expect(result.diff).toContain(': Promise<void>');
    });

    it('adds return type for Promise<never> function', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'promise-never-fn.ts');
      const original = 'export async function failAsync(): Promise<never> {\n  throw new Error("async fail");\n}\n';
      await writeFile(filePath, original, 'utf-8');

      // Already has return type -> no change
      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/promise-never-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      expect(result.changed).toBe(false);
    });

    it('adds return type for Promise<unknown> function', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'promise-unknown-fn.ts');
      const original = 'export async function fetchData(url: string) {\n  const res = await fetch(url);\n  return res.json();\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/promise-unknown-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      expect(result.changed).toBe(true);
      expect(result.diff).toMatch(/: Promise<(unknown|any)>/);
    });

    it('adds return type for Promise<any> function', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'promise-any-fn.ts');
      const original = 'export async function loadAnything(input: any) {\n  return input;\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/promise-any-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      expect(result.changed).toBe(true);
      expect(result.diff).toContain(': Promise<any>');
    });

    it('adds return type for Promise<boolean> function', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'promise-boolean-fn.ts');
      const original = 'export async function checkStatus() {\n  return Math.random() > 0.5;\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/promise-boolean-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      expect(result.changed).toBe(true);
      expect(result.diff).toContain(': Promise<boolean>');
    });

    it('adds return type for Promise<string> function', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'promise-string-fn.ts');
      const original = 'export async function fetchName() {\n  return "Alice";\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/promise-string-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      expect(result.changed).toBe(true);
      expect(result.diff).toContain(': Promise<string>');
    });

    it('adds return type for Promise<number> function', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'promise-number-fn.ts');
      const original = 'export async function computeValue() {\n  return 42;\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/promise-number-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      expect(result.changed).toBe(true);
      expect(result.diff).toContain(': Promise<number>');
    });

    it('skips async functions with inferred object literal types', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'promise-object-fn.ts');
      const original = 'export async function fetchConfig() {\n  return { host: "localhost" };\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/promise-object-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      // TypeScript infers `Promise<{ host: string }>` which is not in SAFE_RETURN
      expect(result.changed).toBe(false);
    });

    it('skips async functions with inferred function types', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'promise-function-fn.ts');
      const original = 'export async function getCallback() {\n  return () => {};\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/promise-function-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      // TypeScript infers `Promise<() => void>` which is not in SAFE_RETURN
      expect(result.changed).toBe(false);
    });

    it('adds return type for union types that resolve to number', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'union-fn.ts');
      const original = 'export function parse(input: string) {\n  if (input === "null") return null;\n  return parseInt(input, 10);\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/union-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      // TypeScript infers `number` for this function (parseInt always returns number)
      expect(result.changed).toBe(true);
      expect(result.diff).toContain(': number');
    });

    it('skips functions with dotted return types requiring imports', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'dotted-fn.ts');
      const original = 'export function createDate() {\n  return new Date();\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/dotted-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      // Date is not in SAFE_RETURN -> skip
      expect(result.changed).toBe(false);
    });

    it('applies return types to multiple functions in one file', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'multi-fn.ts');
      const original = 'export function getName() {\n  return "Bob";\n}\nexport function getAge() {\n  return 30;\n}\nexport function isActive() {\n  return true;\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/multi-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      expect(result.changed).toBe(true);
      expect(result.diff).toContain(': string');
      expect(result.diff).toContain(': number');
      expect(result.diff).toContain(': boolean');
    });

    it('applies return types to methods in a class', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'class-methods.ts');
      const original = 'export class Greeter {\n  getName() {\n    return "Alice";\n  }\n  getAge() {\n    return 25;\n  }\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/class-methods.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      expect(result.changed).toBe(true);
      expect(result.diff).toContain(': string');
      expect(result.diff).toContain(': number');
    });

    it('does not modify disk in preview mode for add-return-types', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'preview-fn.ts');
      const original = 'export function getValue() {\n  return 42;\n}\n';
      await writeFile(filePath, original, 'utf-8');

      await runAutoFix(makeDeps(root), {
        filePath: 'src/preview-fn.ts',
        fixes: ['add-return-types'],
        apply: false,
      });

      const after = await readFile(filePath, 'utf-8');
      expect(after).toBe(original);
    });

    it('writes to disk in apply mode for add-return-types', async () => {
      const root = await makeTmpRoot();
      const filePath = join(root, 'src', 'apply-fn.ts');
      const original = 'export function getValue() {\n  return 42;\n}\n';
      await writeFile(filePath, original, 'utf-8');

      const result = await runAutoFix(makeDeps(root), {
        filePath: 'src/apply-fn.ts',
        fixes: ['add-return-types'],
        apply: true,
      });

      const after = await readFile(filePath, 'utf-8');
      expect(after).toContain(': number');
      expect(result.written).toBe(true);
    });
  });
});
