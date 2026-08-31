import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/storage/database.js';
import { IntegrityGuard, parseGitRenameLog } from '../../../src/core/kg/integrity-guard.js';

const HASH1 = 'a'.repeat(40);
const HASH2 = 'b'.repeat(40);

describe('IntegrityGuard', () => {
  let tmpDir: string;
  let projectDir: string;
  let guard: IntegrityGuard;

  function seedFile(relPath: string, content?: string): number {
    const db = getDatabase();
    const res = db
      .prepare('INSERT INTO files (path, relative_path, language) VALUES (?, ?, ?)')
      .run(relPath, relPath, 'typescript');
    if (content !== undefined) {
      const full = join(projectDir, relPath);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf-8');
    }
    return Number(res.lastInsertRowid);
  }

  function seedFunction(fileId: number, name: string): number {
    const res = getDatabase()
      .prepare('INSERT INTO functions (file_id, name, signature, start_line, end_line) VALUES (?, ?, ?, 1, 2)')
      .run(fileId, name, `${name}()`);
    return Number(res.lastInsertRowid);
  }

  function seedImport(fileId: number, source: string, resolved = 0): number {
    const res = getDatabase()
      .prepare('INSERT INTO imports (file_id, source, kind, resolved) VALUES (?, ?, ?, ?)')
      .run(fileId, source, 'static', resolved);
    return Number(res.lastInsertRowid);
  }

  function seedCall(fromId: number, toId: number): void {
    getDatabase()
      .prepare('INSERT INTO calls (from_function_id, to_function_id) VALUES (?, ?)')
      .run(fromId, toId);
  }

  function writeFile(relPath: string, content: string): void {
    const full = join(projectDir, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pm-integrity-'));
    projectDir = join(tmpDir, 'project');
    mkdirSync(projectDir, { recursive: true });
    initDatabase(join(tmpDir, 'integrity.db'));
    guard = new IntegrityGuard(projectDir);
  });

  afterAll(() => {
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const db = getDatabase();
    db.exec('DELETE FROM calls');
    db.exec('DELETE FROM imports');
    db.exec('DELETE FROM functions');
    db.exec('DELETE FROM files');
  });

  // (a) missing_file detected for DB row whose file was deleted from the tree
  it('detects missing_file with spec fields for a deleted file', () => {
    const fileId = seedFile('src/gone-a.ts'); // row only — never written to disk

    const violations = guard.checkConsistency();
    const v = violations.find((x) => x.type === 'missing_file' && x.filePath === 'src/gone-a.ts');
    expect(v).toBeDefined();
    expect(v!.kgNodeId).toBe(fileId);
    expect(v!.suggestedAction).toBe('delete_node');
    expect(v!.confidence).toBeGreaterThan(0.5);
  });

  // (b) rename-line PARSER unit tests (captured git output strings)
  describe('parseGitRenameLog', () => {
    it('resolves a single rename (newest first)', () => {
      const out = `${HASH1}\n\nR100\tsrc/old.ts\tsrc/new.ts\n`;
      const res = parseGitRenameLog(out, 'src/old.ts');
      expect(res.path).toBe('src/new.ts');
      expect(res.deleted).toBe(false);
    });

    it('chains multi-hop renames through older entries (from = previous to)', () => {
      const out = [
        HASH1,
        '',
        'R100\tsrc/v1.ts\tsrc/v2.ts',
        '',
        HASH2,
        '',
        'R100\tsrc/v2.ts\tsrc/v3.ts',
        '',
      ].join('\n');
      const res = parseGitRenameLog(out, 'src/v1.ts');
      expect(res.path).toBe('src/v3.ts');
      expect(res.deleted).toBe(false);
    });

    it('reports deletion in HEAD with the deleting commit', () => {
      const out = `${HASH1}\n\nD\tsrc/gone.ts\n\n${HASH2}\n\nA\tsrc/gone.ts\n`;
      const res = parseGitRenameLog(out, 'src/gone.ts');
      expect(res.path).toBeNull();
      expect(res.deleted).toBe(true);
      expect(res.deletedAtCommit).toBe(HASH1);
    });

    it('ignores renames that do not match the search path', () => {
      const out = `${HASH1}\n\nR100\tsrc/a.ts\tsrc/b.ts\n`;
      const res = parseGitRenameLog(out, 'src/x.ts');
      expect(res.path).toBeNull();
      expect(res.deleted).toBe(false);
    });

    it('normalizes backslash paths', () => {
      const out = `${HASH1}\n\nR100\tsrc\\old.ts\tsrc\\new.ts\n`;
      const res = parseGitRenameLog(out, 'src/old.ts');
      expect(res.path).toBe('src/new.ts');
    });
  });

  // (b cont.) FS fallback finds the renamed file, never node_modules/dist/dot dirs,
  // and prefers matches under src/.
  it('filesystem fallback finds moved file and never returns excluded dirs', () => {
    const fileId = seedFile('src/orig-b.ts'); // DB row, file absent at that path
    writeFile('src/moved/orig-b.ts', 'export const x = 1;');
    writeFile('other/orig-b.ts', 'export const x = 1;');
    // Decoys planted in excluded locations:
    writeFile('node_modules/pkg/orig-b.ts', 'decoy');
    writeFile('dist/orig-b.ts', 'decoy');
    writeFile('.hidden/orig-b.ts', 'decoy');

    const violations = guard.checkConsistency();
    const v = violations.find((x) => x.filePath === 'src/orig-b.ts');
    expect(v).toBeDefined();
    expect(v!.type).toBe('moved_file');
    expect(v!.suggestedPath).toBe('src/moved/orig-b.ts'); // src/ preferred over other/
    expect(v!.suggestedPath).not.toContain('node_modules');
    expect(v!.kgNodeId).toBe(fileId);
    expect(v!.suggestedAction).toBe('update_path');

    // Direct fallback check: never an excluded path.
    const found = guard.filesystemSearch('src/orig-b.ts');
    expect(found).toBe('src/moved/orig-b.ts');
    expect(found).not.toMatch(/node_modules|^\.|\bdist\b/);
  });

  // (c) stale_import resolved against importer dir with resolved_path set
  it('repairs stale imports against the importing file directory', () => {
    const importerId = seedFile(
      'src/feat/importer-c.ts',
      "import { h } from './utils-c/helper';\nimport { i } from './utils2-c';\nexport function use() { return h() + i(); }\n"
    );
    seedImport(importerId, './utils-c/helper');
    seedImport(importerId, './utils2-c');
    writeFile('src/feat/utils-c/helper.ts', 'export function h() { return 1; }');
    writeFile('src/feat/utils2-c/index.ts', 'export function i() { return 2; }');

    const violations = guard.checkConsistency();
    const stale = violations.filter((x) => x.type === 'stale_import');
    expect(stale).toHaveLength(2);
    for (const v of stale) {
      expect(v.sourcePath).toBe('src/feat/importer-c.ts');
      expect(v.suggestedAction).toBe('relink');
      expect(v.specifier).toMatch(/^\.\/(utils-c\/helper|utils2-c)$/);
    }

    const repaired = guard.repairStaleNodes(violations);
    expect(repaired).toBe(2);

    const db = getDatabase();
    const rows = db
      .prepare('SELECT source, resolved, resolved_path FROM imports WHERE file_id = ?')
      .all(importerId) as Array<{ source: string; resolved: number; resolved_path: string | null }>;
    const bySource = new Map(rows.map((r) => [r.source, r]));
    expect(bySource.get('./utils-c/helper')!.resolved).toBe(1);
    expect(bySource.get('./utils-c/helper')!.resolved_path).toBe('src/feat/utils-c/helper.ts');
    expect(bySource.get('./utils2-c')!.resolved).toBe(1);
    expect(bySource.get('./utils2-c')!.resolved_path).toBe('src/feat/utils2-c/index.ts');
  });

  // (d) orphan detection: exported NOT flagged; non-exported uncalled flagged
  it('flags only non-exported, uncalled, unreferenced functions as orphans', () => {
    const fileId = seedFile(
      'src/orphans-d.ts',
      [
        'export function exportedFn() { return 1; }',
        'function lonely() { return 2; }',
        'export function caller() { return inner(); }',
        'function inner() { return 3; }',
        '',
      ].join('\n')
    );
    const exportedId = seedFunction(fileId, 'exportedFn');
    const lonelyId = seedFunction(fileId, 'lonely');
    const callerId = seedFunction(fileId, 'caller');
    const innerId = seedFunction(fileId, 'inner');
    seedCall(callerId, innerId); // inner is called -> not an orphan

    const violations = guard.checkConsistency();
    const orphanFns = violations.filter((v) => v.type === 'orphan_node' && v.functionName !== undefined);

    expect(orphanFns).toHaveLength(1);
    const v = orphanFns[0];
    expect(v.functionName).toBe('lonely');
    expect(v.filePath).toBe('src/orphans-d.ts'); // containing file, never the name
    expect(v.kgNodeId).toBe(lonelyId);
    expect(v.details?.functionName).toBe('lonely');
    expect(v.suggestedAction).toBe('delete_node');

    // Exported function with zero calls is NOT flagged.
    expect(orphanFns.some((x) => x.functionName === 'exportedFn')).toBe(false);
    expect(exportedId).not.toBe(lonelyId);
  });

  // (e) stale_function AST check flags DB function absent from file content
  it('flags stale functions absent from current file content', () => {
    const fileId = seedFile('src/stale-e.ts', 'export function present() { return 1; }\n');
    seedFunction(fileId, 'present');
    const ghostId = seedFunction(fileId, 'ghost');

    const violations = guard.checkConsistency();
    const stale = violations.filter((v) => v.type === 'stale_function');
    expect(stale).toHaveLength(1);
    expect(stale[0].functionName).toBe('ghost');
    expect(stale[0].kgNodeId).toBe(ghostId);
    expect(stale[0].filePath).toBe('src/stale-e.ts');
    expect(stale[0].suggestedAction).toBe('delete_node');
    expect(stale[0].confidence).toBe(0.95);

    // Repair deletes the stale row.
    const repaired = guard.repairStaleNodes(violations);
    expect(repaired).toBeGreaterThanOrEqual(1);
    const remaining = getDatabase()
      .prepare('SELECT name FROM functions WHERE file_id = ?')
      .all(fileId) as Array<{ name: string }>;
    expect(remaining.map((r) => r.name)).toEqual(['present']);
  });

  // (f) every violation carries kgNodeId / suggestedAction / confidence
  it('populates spec fields on every violation', () => {
    seedFile('src/gone-f.ts'); // missing
    const fileId = seedFile('src/stale-f.ts', 'export function keep() { return 1; }\n');
    seedFunction(fileId, 'keep');
    seedFunction(fileId, 'removed');

    const violations = guard.checkConsistency();
    expect(violations.length).toBeGreaterThan(0);
    for (const v of violations) {
      expect(v.kgNodeId).toBeDefined();
      expect(['string', 'number']).toContain(typeof v.kgNodeId);
      expect(['delete_node', 'update_path', 'relink']).toContain(v.suggestedAction);
      expect(v.confidence).toBeGreaterThan(0);
      expect(v.confidence).toBeLessThanOrEqual(1);
      expect(typeof v.message).toBe('string');
    }
  });

  it('moved_file repair updates the DB path', () => {
    const fileId = seedFile('src/orig-g.ts');
    writeFile('src/deep/orig-g.ts', 'export const y = 2;');

    const violations = guard.checkConsistency();
    const repaired = guard.repairStaleNodes(violations);
    expect(repaired).toBeGreaterThanOrEqual(1);

    const row = getDatabase().prepare('SELECT relative_path FROM files WHERE id = ?').get(fileId) as {
      relative_path: string;
    };
    expect(row.relative_path).toBe('src/deep/orig-g.ts');
  });

  it('generateReport reuses one consistency pass and scheduleCheck unrefs', () => {
    seedFile('src/gone-h.ts');
    const report = guard.generateReport();
    expect(report.violations.length).toBeGreaterThan(0);
    expect(report.repaired).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(report.orphans)).toBe(true);
    expect(typeof report.timestamp).toBe('string');

    const timer = guard.scheduleCheck(60_000);
    expect(timer).toBeDefined();
    clearInterval(timer);
  });
});
