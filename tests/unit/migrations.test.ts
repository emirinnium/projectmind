import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { getCurrentSchemaVersion, rollbackMigrations, rollbackLast, setSchemaVersion, removeSchemaVersion } from '../../src/storage/migrations.js';

function createTestDbWithoutMigrations(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

describe('Migration Rollback', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDbWithoutMigrations();
  });

  describe('getCurrentSchemaVersion', () => {
    it('returns 0 when no schema version table exists', () => {
      const version = getCurrentSchemaVersion(db);
      expect(version).toBe(0);
    });

    it('returns the highest version number', () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(1, 'initial');
      db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(2, 'second');

      const version = getCurrentSchemaVersion(db);
      expect(version).toBe(2);
    });
  });

  describe('setSchemaVersion', () => {
    it('inserts a new schema version', () => {
      setSchemaVersion(db, 1, 'test-migration');

      const version = getCurrentSchemaVersion(db);
      expect(version).toBe(1);
    });

    it('replaces existing version with same number', () => {
      setSchemaVersion(db, 1, 'first');
      setSchemaVersion(db, 1, 'replaced');

      const row = db.prepare('SELECT name FROM schema_version WHERE version = ?').get(1) as { name: string };
      expect(row.name).toBe('replaced');
    });
  });

  describe('removeSchemaVersion', () => {
    it('removes a specific schema version', () => {
      setSchemaVersion(db, 1, 'first');
      setSchemaVersion(db, 2, 'second');

      removeSchemaVersion(db, 1);

      const version = getCurrentSchemaVersion(db);
      expect(version).toBe(2);

      const row = db.prepare('SELECT * FROM schema_version WHERE version = ?').get(1);
      expect(row).toBeUndefined();
    });
  });

  describe('rollbackMigrations', () => {
    it('does nothing when target version >= current', () => {
      setSchemaVersion(db, 3, 'third');

      rollbackMigrations(db, 3);

      const version = getCurrentSchemaVersion(db);
      expect(version).toBe(3);
    });

    it('rolls back to target version', () => {
      // Create the calls table (migration 2)
      db.exec(`
        CREATE TABLE IF NOT EXISTS calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_function_id INTEGER NOT NULL,
          to_function_id INTEGER NOT NULL,
          dynamic BOOLEAN DEFAULT 0,
          static_missed BOOLEAN DEFAULT 0,
          call_count INTEGER DEFAULT 1,
          workload_id TEXT,
          detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      setSchemaVersion(db, 1, 'initial');
      setSchemaVersion(db, 2, 'add_calls_table');

      // Rollback to version 1 (should drop calls table)
      rollbackMigrations(db, 1);

      const version = getCurrentSchemaVersion(db);
      expect(version).toBe(1);

      // Verify calls table was dropped
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='calls'").get();
      expect(table).toBeUndefined();
    });
  });

  describe('rollbackLast', () => {
    it('rolls back the last N migrations', () => {
      // Create the settings table (migration 4)
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      setSchemaVersion(db, 1, 'initial');
      setSchemaVersion(db, 2, 'add_calls_table');
      setSchemaVersion(db, 4, 'add_settings_table');

      rollbackLast(db, 1);

      const version = getCurrentSchemaVersion(db);
      expect(version).toBe(2);
    });
  });
});
