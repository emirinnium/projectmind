import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { getCurrentSchemaVersion, rollbackMigrations, rollbackLast, setSchemaVersion, removeSchemaVersion, runMigrations } from '../../src/storage/migrations.js';

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

describe('Legacy DB upgrades', () => {
  /**
   * Simulate a persisted DB created by a pre-v7 version of ProjectMind:
   * - files WITHOUT the last_synced column
   * - debt_items with the OLD 4-type CHECK constraint
   * - team_memories WITHOUT base_value (needed so migration 8 can run)
   */
  function createV6Db(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');

    db.exec(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        language TEXT,
        size_bytes INTEGER DEFAULT 0,
        cognitive_load REAL DEFAULT 0,
        hash TEXT,
        last_scanned TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        project_id INTEGER DEFAULT 1
      );
      CREATE TABLE debt_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER,
        type TEXT CHECK(type IN ('pattern_drift', 'architectural_drift', 'redundancy', 'agent_conflict')),
        description TEXT,
        severity TEXT CHECK(severity IN ('high', 'medium', 'low')),
        suggestion TEXT,
        reasoning_trace TEXT,
        detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        resolved BOOLEAN DEFAULT 0,
        resolved_at TIMESTAMP
      );
      CREATE TABLE team_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name TEXT NOT NULL,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        is_public BOOLEAN DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Existing rows that the ALTER must not break
    db.prepare('INSERT INTO files (path, language, last_scanned) VALUES (?, ?, ?)')
      .run('src/legacy.ts', 'typescript', '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO debt_items (file_id, type, description, severity) VALUES (?, ?, ?, ?)')
      .run(1, 'pattern_drift', 'legacy debt', 'high');

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    setSchemaVersion(db, 6, 'team_memories_unique_scope_key');
    return db;
  }

  it('upgrades a v6 DB to the latest schema without error', () => {
    const db = createV6Db();

    runMigrations(db);

    expect(getCurrentSchemaVersion(db)).toBe(8);

    // last_synced added as a NULLABLE column (no non-constant default —
    // SQLite forbids DEFAULT CURRENT_TIMESTAMP in ADD COLUMN)
    const filesColumns = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string; dflt_value: string | null }>;
    const lastSynced = filesColumns.find((c) => c.name === 'last_synced');
    expect(lastSynced).toBeDefined();
    expect(lastSynced?.dflt_value).toBeNull();

    // Existing rows survive with NULL last_synced (readers fall back to last_scanned)
    const row = db.prepare('SELECT last_synced, last_scanned FROM files WHERE id = 1').get() as { last_synced: string | null; last_scanned: string };
    expect(row.last_synced).toBeNull();
    expect(row.last_scanned).toBe('2026-01-01T00:00:00.000Z');

    // debt_items rebuilt with the expanded 7-type CHECK
    db.prepare(`INSERT INTO debt_items (file_id, type, description, severity) VALUES (?, ?, ?, ?)`)
      .run(1, 'complexity', 'new type allowed', 'medium');
    const count = db.prepare('SELECT COUNT(*) as c FROM debt_items').get() as { c: number };
    expect(count.c).toBe(2);
  });
});
