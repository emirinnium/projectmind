import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '@/storage/migrations.js';
import { SCHEMA_SQL } from '@/storage/schema.js';
import {
  createDatabaseBackup,
  restoreDatabaseFile,
  validateDatabaseBackup,
} from '@/storage/database-backup.js';

describe('database backup and restore', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function createProjectDatabase(root: string, fileName: string): DatabaseSync {
    const db = new DatabaseSync(join(root, fileName));
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run('fixture', root);
    return db;
  }

  it('creates a consistent, integrity-checked SQLite snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-db-backup-'));
    roots.push(root);
    const db = createProjectDatabase(root, 'project.db');
    const backup = join(root, 'project.db.backup');

    createDatabaseBackup(db, backup);
    expect(existsSync(backup)).toBe(true);
    expect(validateDatabaseBackup(backup)).toMatchObject({
      valid: true,
      integrity: 'ok',
      schemaVersion: 111,
    });

    const restored = new DatabaseSync(backup, { readOnly: true });
    expect(restored.prepare('SELECT name FROM projects').get()).toMatchObject({ name: 'fixture' });
    restored.close();
    db.close();
  });

  it('restores a validated snapshot after the active connection is closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-db-restore-'));
    roots.push(root);
    const databasePath = join(root, 'project.db');
    const backupPath = join(root, 'project.db.backup');
    const db = createProjectDatabase(root, 'project.db');
    createDatabaseBackup(db, backupPath);
    db.prepare('UPDATE projects SET name = ?').run('mutated');
    db.close();

    restoreDatabaseFile(databasePath, backupPath);
    const restored = new DatabaseSync(databasePath, { readOnly: true });
    expect(restored.prepare('SELECT name FROM projects').get()).toMatchObject({ name: 'fixture' });
    restored.close();
  });

  it('rejects invalid or ambiguous restore inputs without changing files', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-db-invalid-'));
    roots.push(root);
    const databasePath = join(root, 'project.db');
    const db = createProjectDatabase(root, 'project.db');
    expect(() => createDatabaseBackup(db, databasePath)).toThrow(/destination already exists/);
    db.close();
    expect(validateDatabaseBackup(join(root, 'missing.db')).valid).toBe(false);
    expect(() => restoreDatabaseFile(databasePath, join(root, 'missing.db'))).toThrow(
      /not restorable/,
    );
  });
});
