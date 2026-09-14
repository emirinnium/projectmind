import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase, initDatabase } from '../../src/storage/database.js';
import { ProjectScanner } from '../../src/core/scale/reporting/scanner.js';
import { stableHash } from '../../src/utils/hash.js';
import { getDatabase } from '../../src/storage/database.js';
import { getImportStats } from '../../src/storage/kg/helpers/imports.js';

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

  it('uses UTF-8 byte size so non-ASCII files remain incremental-stable', async () => {
    const filePath = join(root, 'src', 'unicode.ts');
    const source = 'export const label = "ışık 🚀";\n';
    await writeFile(filePath, source, 'utf8');

    const scanner = new ProjectScanner();
    const first = await scanner.scanProjectWithProfile(root, true);
    expect(first.scannedFiles).toBe(1);

    const db = (scanner as unknown as { db: DatabaseSync }).db;
    const stored = db
      .prepare('SELECT size_bytes FROM files WHERE relative_path = ?')
      .get('src/unicode.ts') as { size_bytes: number };
    expect(stored.size_bytes).toBe(Buffer.byteLength(source, 'utf8'));
    expect(stored.size_bytes).not.toBe(source.length);

    const second = await scanner.scanProjectWithProfile(root, false);
    expect(second.scannedFiles).toBe(0);
    expect(second.errorFiles).toBe(0);
  });

  it('repairs separator-only duplicate file rows before incremental filtering', async () => {
    const filePath = join(root, 'src', 'duplicate.ts');
    const source = 'export const duplicate = true;\n';
    await writeFile(filePath, source, 'utf8');

    const scanner = new ProjectScanner();
    const first = await scanner.scanProjectWithProfile(root, true);
    expect(first.errorFiles).toBe(0);

    const db = (scanner as unknown as { db: DatabaseSync }).db;
    const canonicalPath = filePath.replace(/\\/g, '/');
    const separator = String.fromCharCode(92);
    const legacyPath = canonicalPath.replace(/\//g, separator);
    db.prepare(
      `INSERT INTO files
       (project_id, path, relative_path, language, size_bytes, hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      legacyPath,
      `src${separator}duplicate.ts`,
      'typescript',
      Buffer.byteLength(source, 'utf8'),
      stableHash(source),
    );

    const second = await scanner.scanProjectWithProfile(root, false);
    expect(second.errorFiles).toBe(0);
    expect(second.scannedFiles).toBe(0);

    const rows = db
      .prepare(
        "SELECT path, relative_path FROM files WHERE project_id = 1 AND relative_path = 'src/duplicate.ts'",
      )
      .all() as Array<{ path: string; relative_path: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ path: canonicalPath, relative_path: 'src/duplicate.ts' });
  });

  it('repairs import edges after a target is discovered later in scan order', async () => {
    await writeFile(
      join(root, 'src', 'a-consumer.ts'),
      "import { target } from './z-target';\nexport const consumer = target;\n",
      'utf8',
    );
    await writeFile(join(root, 'src', 'z-target.ts'), 'export const target = true;\n', 'utf8');

    const scanner = new ProjectScanner();
    const result = await scanner.scanProjectWithProfile(root, true);
    expect(result.errorFiles).toBe(0);

    const db = (scanner as unknown as { db: DatabaseSync }).db;
    const importer = db
      .prepare('SELECT id FROM files WHERE relative_path = ? AND project_id = ?')
      .get('src/a-consumer.ts', 1) as { id: number };
    expect(
      db.prepare('SELECT resolved, resolved_path FROM imports WHERE file_id = ?').get(importer.id),
    ).toEqual({ resolved: 1, resolved_path: 'src/z-target.ts' });
  });

  it('reprocesses direct dependents when an indexed target changes', async () => {
    const targetPath = join(root, 'src', 'target.ts');
    await writeFile(targetPath, 'export function target(): boolean { return true; }\n', 'utf8');
    await writeFile(
      join(root, 'src', 'consumer.ts'),
      "import { target } from './target.js';\nexport const result = target();\n",
      'utf8',
    );

    const scanner = new ProjectScanner();
    const first = await scanner.scanProjectWithProfile(root, true);
    expect(first.errorFiles).toBe(0);

    await writeFile(targetPath, 'export function target(): boolean { return false; }\n', 'utf8');
    const incremental = await scanner.scanProjectWithProfile(root, false);

    expect(incremental.errorFiles).toBe(0);
    expect(incremental.scannedFiles).toBe(2);
    expect(incremental.dependencyFiles).toBe(1);
    expect(incremental.dependencyDepth).toBe(1);
  });

  it('keeps exact JavaScript targets ahead of TypeScript source equivalents', async () => {
    await writeFile(
      join(root, 'src', 'consumer.ts'),
      "import { target } from './target.js';\nexport const consumer = target;\n",
      'utf8',
    );
    await writeFile(join(root, 'src', 'target.js'), 'export const target = true;\n', 'utf8');

    const scanner = new ProjectScanner();
    const result = await scanner.scanProjectWithProfile(root, true);
    expect(result.errorFiles).toBe(0);

    const db = (scanner as unknown as { db: DatabaseSync }).db;
    const importer = db
      .prepare('SELECT id FROM files WHERE relative_path = ? AND project_id = ?')
      .get('src/consumer.ts', 1) as { id: number };
    expect(
      db.prepare('SELECT resolved, resolved_path FROM imports WHERE file_id = ?').get(importer.id),
    ).toEqual({ resolved: 1, resolved_path: 'src/target.js' });
  });
});

describe('Project import analysis', () => {
  afterEach(() => closeDatabase());

  it('aggregates persisted import edges in one project-scoped query', () => {
    initDatabase(':memory:');
    const db = getDatabase();
    db.prepare(
      'INSERT INTO files (project_id, path, relative_path, language) VALUES (?, ?, ?, ?)',
    ).run(1, '/repo/src/a.ts', 'src/a.ts', 'typescript');
    db.prepare(
      'INSERT INTO files (project_id, path, relative_path, language) VALUES (?, ?, ?, ?)',
    ).run(1, '/repo/src/b.ts', 'src/b.ts', 'typescript');
    const owner = db
      .prepare('SELECT id FROM files WHERE relative_path = ? AND project_id = ?')
      .get('src/a.ts', 1) as { id: number };
    db.prepare(
      'INSERT INTO imports (file_id, source, named, kind, resolved, resolved_path) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(owner.id, './b.js', '[]', 'import', 1, 'src/b.ts');
    db.prepare(
      'INSERT INTO imports (file_id, source, named, kind, resolved, resolved_path) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(owner.id, 'node:fs', '[]', 'import', 1, 'fs');
    db.prepare(
      'INSERT INTO imports (file_id, source, named, kind, resolved, resolved_path) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(owner.id, 'external-package', '[]', 'import', 0, null);
    db.prepare(
      'INSERT INTO imports (file_id, source, named, kind, resolved, resolved_path) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(owner.id, './missing.js', '[]', 'import', 1, 'src/b.ts');

    expect(getImportStats({ db, currentProjectId: 1, projectRoot: '/repo' })).toEqual({
      totalImports: 4,
      resolvedImports: 1,
      unresolvedImports: 3,
      externalDependencies: 2,
    });
  });
});
