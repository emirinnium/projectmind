import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAutoFix } from '../../../src/mcp/tools/auto-fix.js';
/**
 * Minimal McpDependencies stub — runAutoFix only relies on `projectRoot`,
 * so the rest of the surface is left as a partial cast.
 */
function makeDeps(projectRoot) {
    return { projectRoot };
}
describe('auto_fix (runAutoFix)', () => {
    const tmpRoots = [];
    afterAll(async () => {
        for (const root of tmpRoots) {
            await rm(root, { recursive: true, force: true });
        }
    });
    async function makeTmpRoot() {
        const root = await mkdtemp(join(tmpdir(), 'pm-autofix-'));
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
        const original = "import { readFile } from 'node:fs/promises';\n\nexport async function f() {\n  const x = 1;\n  await readFile('a');\n  return x;\n}\n";
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
        await expect(runAutoFix(makeDeps(root), { filePath: '../outside.ts', fixes: ['var-to-const'] })).rejects.toThrow(/escapes project root/i);
    });
});
//# sourceMappingURL=auto-fix.test.js.map