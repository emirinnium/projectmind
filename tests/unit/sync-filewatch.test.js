import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLiveWatch, stopLiveWatch, closeAllLiveWatchers, liveWatcherStats, hasLiveWatch, } from '../../src/mcp/tools/sync.js';
const fakeDeps = {
    kg: {
        markAgentTouched: () => Promise.resolve(),
        upsertFile: async () => 1,
        storeFileDetails: () => Promise.resolve(),
    },
};
describe('live file watches — unregister_file_watch resurrection fix', () => {
    const tempDirs = [];
    function makeTempFile() {
        const dir = mkdtempSync(join(tmpdir(), 'pm-filewatch-'));
        tempDirs.push(dir);
        const file = join(dir, 'watched.ts');
        writeFileSync(file, 'export const x = 1;\n');
        return file;
    }
    afterEach(() => {
        closeAllLiveWatchers();
        for (const dir of tempDirs.splice(0)) {
            try {
                rmSync(dir, { recursive: true, force: true });
            }
            catch {
                // best effort cleanup
            }
        }
    });
    it('stopLiveWatch truly stops the watch — no resurrection', async () => {
        const file = makeTempFile();
        startLiveWatch(fakeDeps, file, 'agent-a');
        await new Promise((r) => setTimeout(r, 20));
        expect(hasLiveWatch(file, 'agent-a')).toBe(true);
        expect(liveWatcherStats().active).toBe(1);
        stopLiveWatch(file, 'agent-a');
        await new Promise((r) => setTimeout(r, 50));
        expect(liveWatcherStats().active).toBe(0);
        expect(liveWatcherStats().pendingRestarts).toBe(0);
        expect(hasLiveWatch(file, 'agent-a')).toBe(false);
        // Still stopped after the handlers have had time to fire.
        await new Promise((r) => setTimeout(r, 250));
        expect(liveWatcherStats().active).toBe(0);
        expect(liveWatcherStats().pendingRestarts).toBe(0);
    });
    it('closeAllLiveWatchers clears every watch and pending restart', async () => {
        const file = makeTempFile();
        startLiveWatch(fakeDeps, file, 'agent-a');
        startLiveWatch(fakeDeps, file, 'agent-b');
        await new Promise((r) => setTimeout(r, 20));
        expect(liveWatcherStats().active).toBe(2);
        closeAllLiveWatchers();
        await new Promise((r) => setTimeout(r, 50));
        expect(liveWatcherStats().active).toBe(0);
        expect(liveWatcherStats().pendingRestarts).toBe(0);
    });
});
//# sourceMappingURL=sync-filewatch.test.js.map