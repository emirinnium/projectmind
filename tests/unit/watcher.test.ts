import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectWatcher } from '../../src/core/watcher.js';

type WatcherKg = ConstructorParameters<typeof ProjectWatcher>[0];

describe('ProjectWatcher — cross-platform recursive watching', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pm-watcher-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }
  });

  it('start() on a temp dir does not throw; isRunning() tracks start/stop', () => {
    const dir = makeTempDir();
    const kg: WatcherKg = {
      upsertFile: async () => 1,
      storeFileDetails: async () => {},
    };
    const watcher = new ProjectWatcher(kg, { root: dir });

    expect(() => watcher.start()).not.toThrow();
    expect(watcher.isRunning()).toBe(true);

    watcher.stop();
    expect(watcher.isRunning()).toBe(false);
  });

  it('isTrackable accepts trackable sources and rejects ignored/foreign paths', () => {
    const dir = makeTempDir();
    const kg: WatcherKg = {
      upsertFile: async () => 1,
      storeFileDetails: async () => {},
    };
    const watcher = new ProjectWatcher(kg, { root: dir });

    expect(watcher.isTrackable(join(dir, 'src/a.ts'))).toBe(true);
    expect(watcher.isTrackable(join(dir, 'node_modules/x.ts'))).toBe(false);
    expect(watcher.isTrackable(join(dir, '..', 'out.ts'))).toBe(false);
    expect(watcher.isTrackable(join(dir, 'a.txt'))).toBe(false);
  });

  it('detects a live change and refreshes the KG (upsertFile + storeFileDetails)', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');

    const upserted: string[] = [];
    let detailsCalls = 0;
    const kg: WatcherKg = {
      upsertFile: async (_struct, rel) => {
        upserted.push(rel);
        return 1;
      },
      storeFileDetails: async () => {
        detailsCalls++;
      },
    };
    const watcher = new ProjectWatcher(kg, { root: dir, debounceMs: 50 });
    watcher.start();
    try {
      appendFileSync(join(dir, 'a.ts'), 'export const b = 2;\n');

      const deadline = Date.now() + 3000;
      while (upserted.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(upserted).toContain('a.ts');

      const detailsDeadline = Date.now() + 1000;
      while (detailsCalls === 0 && Date.now() < detailsDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(detailsCalls).toBeGreaterThan(0);
    } finally {
      watcher.stop();
    }
  });
});
