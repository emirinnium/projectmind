import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase, initDatabase } from '../../src/storage/database.js';
import { ProjectScanner } from '../../src/core/scale/reporting/scanner.js';
import { stableHash } from '../../src/utils/hash.js';

describe('ProjectScanner incremental freshness', () => {
  let root: string;

  beforeEach(async () => {
    initDatabase(':memory:');
    root = await mkdtemp(join(tmpdir(), 'projectmind-scanner-'));
    await mkdir(join(root, 'src'));
  });

  afterEach(async () => {
    closeDatabase();
    await rm(root, { recursive: true, force: true });
  });

  it('rescans same-size content changes even when the indexed mtime is newer', async () => {
    const filePath = join(root, 'src', 'state.ts');
    const initial = 'export const value = 1;\n';
    const changed = 'export const value = 2;\n';
    expect(changed.length).toBe(initial.length);
    await writeFile(filePath, initial, 'utf8');

    const scanner = new ProjectScanner();
    const first = await scanner.scanProjectWithProfile(root, true);
    expect(first.scannedFiles).toBe(1);

    const db = (scanner as unknown as { db: DatabaseSync }).db;
    const manifest = db
      .prepare("SELECT value FROM settings WHERE key = 'embedding_index_config:1'")
      .get() as { value: string } | undefined;
    expect(manifest?.value).toContain('"activeProvider":"simple"');
    expect(
      (JSON.parse(manifest?.value ?? '{}') as { effectiveDimensions?: number[] })
        .effectiveDimensions,
    ).toEqual([768]);

    // A provider/index configuration change must invalidate hash-only
    // incremental filtering; otherwise old vectors would remain comparable
    // only by shape, not by meaning.
    db.prepare(
      "UPDATE settings SET value = 'stale-config' WHERE key = 'embedding_index_config:1'",
    ).run();
    db.prepare('UPDATE files SET last_scanned = ? WHERE relative_path = ?').run(
      '2099-01-01 00:00:00',
      'src/state.ts',
    );
    await writeFile(filePath, changed, 'utf8');

    const second = await scanner.scanProjectWithProfile(root, false);
    expect(second.scannedFiles).toBe(1);
    expect(
      (
        db.prepare('SELECT hash FROM files WHERE relative_path = ?').get('src/state.ts') as {
          hash: string;
        }
      ).hash,
    ).toBe(stableHash(changed));
  });
});
