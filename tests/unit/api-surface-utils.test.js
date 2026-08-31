import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getApiAtRef } from '../../src/cli/commands/api-surface-utils.js';
/** git is only required for the committed-tree vectors; detect once. */
const hasGit = (() => {
    try {
        execFileSync('git', ['--version'], { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
})();
/** Quiet git helper for fixture setup (stderr/stdout discarded). */
function git(args, cwd) {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
}
describe('getApiAtRef — command-injection hardening (shell:false)', () => {
    let tmpDir;
    beforeAll(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'pm-api-ref-'));
    });
    afterAll(() => {
        try {
            rmSync(tmpDir, { recursive: true, force: true });
        }
        catch {
            /* ignore */
        }
    });
    it('does not execute shell metacharacters embedded in the ref', async () => {
        const nongit = join(tmpDir, 'nongit');
        mkdirSync(nongit, { recursive: true });
        const marker = join(tmpDir, 'pwned-by-ref.txt');
        // Under the old spawnSync(..., { shell: true }), '&' chained a second
        // shell command (cmd.exe on Windows, sh on POSIX) that created the marker.
        // With execFileSync + an argv array there is no shell to interpret it.
        const maliciousRef = `no-such-ref & echo pwned > "${marker}"`;
        const symbols = await getApiAtRef(maliciousRef, nongit);
        expect(symbols).toEqual([]);
        expect(existsSync(marker)).toBe(false);
    });
    it('rejects option-shaped refs (argument-injection guard)', async () => {
        const nongit = join(tmpDir, 'nongit2');
        mkdirSync(nongit, { recursive: true });
        expect(await getApiAtRef('--upload-pack=evil', nongit)).toEqual([]);
        expect(await getApiAtRef('', nongit)).toEqual([]);
    });
    it.skipIf(!hasGit)('reads files whose NAMES contain shell metacharacters without executing them', async () => {
        const repo = join(tmpDir, 'repo');
        mkdirSync(repo, { recursive: true });
        git(['init', '-q'], repo);
        git(['config', 'user.email', 'test@example.com'], repo);
        git(['config', 'user.name', 'Test'], repo);
        // Platform-specific injection payload that empirically executed when the
        // repo-derived filename was interpolated into `git show ${ref}:${rel}`
        // under shell:true. The marker file only exists if the command ran.
        const isWin = process.platform === 'win32';
        const markerName = isWin ? 'PM-PWNED-marker.txt.ts' : 'PM-PWNED-marker.ts';
        const evilName = isWin ? `x&copy nul ${markerName}` : `x&touch ${markerName}`;
        const marker = join(repo, markerName);
        writeFileSync(join(repo, evilName), 'export function evil(): number { return 1; }\n');
        writeFileSync(join(repo, 'clean.ts'), 'export function clean(): number { return 1; }\n');
        git(['add', '-A'], repo);
        git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], repo);
        const symbols = await getApiAtRef('HEAD', repo);
        // Both files are read through git as DATA — no shell ever parses the name.
        expect(symbols.some((s) => s.name === 'evil')).toBe(true);
        expect(symbols.some((s) => s.name === 'clean')).toBe(true);
        // And the injected command never ran.
        expect(existsSync(marker)).toBe(false);
    });
});
//# sourceMappingURL=api-surface-utils.test.js.map