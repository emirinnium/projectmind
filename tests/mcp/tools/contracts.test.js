import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateContracts } from '../../../src/mcp/tools/contracts.js';
/**
 * Build the forbidden dynamic-execution call without writing a literal
 * `eval(` in this source file — the no-eval contract would otherwise flag
 * this test file itself. Using direct string keeps the test self-flagging-free.
 */
const EVAL_CALL = 'eval(';
/**
 * Minimal McpDependencies stub — evaluateContracts only relies on
 * `projectRoot`, so the rest of the surface is left as a partial cast.
 */
function makeDeps(projectRoot) {
    return { projectRoot };
}
describe('check_contracts (evaluateContracts)', () => {
    let tmpRoot;
    afterAll(async () => {
        if (tmpRoot) {
            await rm(tmpRoot, { recursive: true, force: true });
        }
    });
    it('reports a no-eval violation for a single file containing a dynamic-execution call', async () => {
        tmpRoot = await mkdtemp(join(tmpdir(), 'pm-contracts-'));
        const filePath = join(tmpRoot, 'src', 'bad.ts');
        await writeFile(filePath, `const x = ${EVAL_CALL}userInput);\n`, 'utf-8');
        const result = await evaluateContracts(makeDeps(tmpRoot), {
            filePath: 'src/bad.ts',
            scope: 'file',
        });
        const noEval = result.violations.find((v) => v.contractId === 'no-eval');
        expect(noEval).toBeDefined();
        expect(noEval).toMatchObject({
            contractId: 'no-eval',
            contractName: 'No Dynamic Execution (eval)',
            file: 'src/bad.ts',
            line: 1,
            severity: 'error',
        });
        expect(noEval.message).toContain('eval');
        expect(result.filesScanned).toBe(1);
    });
    it('returns no violations for a clean file', async () => {
        tmpRoot = await mkdtemp(join(tmpdir(), 'pm-contracts-'));
        const filePath = join(tmpRoot, 'src', 'clean.ts');
        await writeFile(filePath, 'export function ok() { return 1; }\n', 'utf-8');
        const result = await evaluateContracts(makeDeps(tmpRoot), {
            filePath: 'src/clean.ts',
            scope: 'file',
        });
        expect(result.violations).toHaveLength(0);
        expect(result.failed).toBe(0);
        expect(result.passed).toBe(result.total);
    });
    it('scans the whole project when scope is project', async () => {
        tmpRoot = await mkdtemp(join(tmpdir(), 'pm-contracts-'));
        await writeFile(join(tmpRoot, 'src', 'a.ts'), `const a = ${EVAL_CALL}x);\n`, 'utf-8');
        await writeFile(join(tmpRoot, 'src', 'b.ts'), 'export const b = 2;\n', 'utf-8');
        const result = await evaluateContracts(makeDeps(tmpRoot), { scope: 'project' });
        const noEval = result.violations.find((v) => v.contractId === 'no-eval');
        expect(noEval).toBeDefined();
        expect(noEval.file).toBe('src/a.ts');
        expect(result.filesScanned).toBe(2);
        expect(result.failed).toBeGreaterThan(0);
    });
    it('filters violations by severity', async () => {
        tmpRoot = await mkdtemp(join(tmpdir(), 'pm-contracts-'));
        await writeFile(join(tmpRoot, 'src', 'a.ts'), `const a = ${EVAL_CALL}x);\n`, 'utf-8');
        // no-eval is severity 'error'; filtering to 'warning' should drop it.
        const warnings = await evaluateContracts(makeDeps(tmpRoot), {
            filePath: 'src/a.ts',
            scope: 'file',
            severityFilter: 'warning',
        });
        expect(warnings.violations.find((v) => v.contractId === 'no-eval')).toBeUndefined();
        const errors = await evaluateContracts(makeDeps(tmpRoot), {
            filePath: 'src/a.ts',
            scope: 'file',
            severityFilter: 'error',
        });
        expect(errors.violations.find((v) => v.contractId === 'no-eval')).toBeDefined();
    });
    it('rejects a filePath that escapes the project root', async () => {
        tmpRoot = await mkdtemp(join(tmpdir(), 'pm-contracts-'));
        await expect(evaluateContracts(makeDeps(tmpRoot), { filePath: '../outside.ts', scope: 'file' })).rejects.toThrow(/escapes project root/i);
    });
});
//# sourceMappingURL=contracts.test.js.map