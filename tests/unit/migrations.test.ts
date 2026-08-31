import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { getCurrentSchemaVersion, migrations, rollbackMigrations, rollbackLast, setSchemaVersion, removeSchemaVersion, runMigrations } from '../../src/storage/migrations.js';
import { SCHEMA_SQL } from '../../src/storage/schema.js';

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

    expect(getCurrentSchemaVersion(db)).toBe(95);

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

    // debt_items rebuilt with the expanded 8-type CHECK (v94 adds 'change_frequency')
    db.prepare(`INSERT INTO debt_items (file_id, type, description, severity) VALUES (?, ?, ?, ?)`)
      .run(1, 'change_frequency', 'new type allowed', 'medium');
    const count = db.prepare('SELECT COUNT(*) as c FROM debt_items').get() as { c: number };
    expect(count.c).toBe(2);
  });

  it('migration 10 wipes legacy PLAINTEXT oauth tokens (K6)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    // Simulate a v9 DB with a plaintext token already persisted.
    db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        scope TEXT,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        secret_hash TEXT,
        metadata TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    setSchemaVersion(db, 9, 'add_oauth_persistence');
    db.prepare('INSERT INTO oauth_clients (client_id, secret_hash, metadata, created_at) VALUES (?, ?, ?, ?)')
      .run('c1', 'x', '{}', 1);
    db.prepare('INSERT INTO oauth_tokens (token, client_id, scope, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run('pm_legacy_plaintext_abc', 'c1', null, 1, 9999999999999);

    runMigrations(db);

    const leftover = db.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get() as { n: number };
    expect(leftover.n).toBe(0);
    // New-style rows (already hashed) are untouched — idempotent re-runs safe.
    setSchemaVersion(db, 10, 'hash_oauth_tokens');
    runMigrations(db);
    expect(getCurrentSchemaVersion(db)).toBe(95);
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get()).toEqual({ n: 0 });
    db.close();
  });

  it('migration 11 dedupes duplicate cycle rows and enforces UNIQUE (K10)', () => {
    const db = new DatabaseSync(':memory:');
    // Legacy table WITHOUT the unique index, holding duplicates.
    db.exec(`
      CREATE TABLE circular_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_path TEXT NOT NULL,
        file_count INTEGER NOT NULL,
        detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        resolved BOOLEAN DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    setSchemaVersion(db, 10, 'hash_oauth_tokens');
    db.prepare('INSERT INTO circular_dependencies (cycle_path, file_count) VALUES (?, ?)').run('a -> b -> a', 3);
    db.prepare('INSERT INTO circular_dependencies (cycle_path, file_count) VALUES (?, ?)').run('a -> b -> a', 3); // dup
    db.prepare('INSERT INTO circular_dependencies (cycle_path, file_count) VALUES (?, ?)').run('x -> y -> x', 3);

    runMigrations(db);

    const left = db.prepare('SELECT COUNT(*) AS n FROM circular_dependencies').get() as { n: number };
    expect(left.n).toBe(2);
    // Uniqueness is now enforced at the DB level — INSERT OR IGNORE is real.
    db.prepare('INSERT OR IGNORE INTO circular_dependencies (cycle_path, file_count) VALUES (?, ?)').run('a -> b -> a', 3);
    expect((db.prepare('SELECT COUNT(*) AS n FROM circular_dependencies').get() as { n: number }).n).toBe(2);
    db.close();
  });
});

describe('Migration 93 — pending_intents unix-ms reconciliation (F40)', () => {
  const CANONICAL_COLUMNS = [
    'id',
    'agent_id',
    'intent_type',
    'target_files',
    'session_id',
    'description',
    'expected_changes',
    'broadcast_at',
    'expires_at',
  ];

  function tableInfo(db: DatabaseSync): Array<{ name: string; type: string }> {
    return db.prepare('PRAGMA table_info(pending_intents)').all() as Array<{ name: string; type: string }>;
  }

  /**
   * EXACT pending_intents DDL shipped in the pre-delivery schema.ts (v0.9.0,
   * commit f9a2993): TIMESTAMP datetime columns and NO expected_changes
   * column. This is the genuine shape that broke migration 93 — fixtures
   * below must never "improve" it by adding expected_changes back.
   */
  const GENUINE_OLD_SHAPE_DDL = `
    CREATE TABLE pending_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      intent_type TEXT NOT NULL CHECK(intent_type IN ('read','write','refactor','delete')),
      target_files TEXT NOT NULL,
      session_id TEXT,
      description TEXT,
      broadcast_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL DEFAULT (datetime('now', '+5 minutes'))
    );
    CREATE INDEX idx_pending_intents_agent ON pending_intents(agent_id);
    CREATE INDEX idx_pending_intents_type ON pending_intents(intent_type);
  `;

  it('converts the legacy v92 shape (seconds + ttl_seconds) to canonical unix-ms', () => {
    const db = new DatabaseSync(':memory:');
    // Exact legacy migration-92 shape: VARCHAR(36) id, seconds-based
    // timestamp, ttl_seconds, expected_changes, NO expires_at.
    db.exec(`
      CREATE TABLE pending_intents (
        id VARCHAR(36) PRIMARY KEY,
        agent_id VARCHAR(255) NOT NULL,
        intent_type VARCHAR(20) NOT NULL,
        target_files TEXT,
        expected_changes TEXT,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        ttl_seconds INTEGER DEFAULT 300
      );
      CREATE INDEX idx_pending_intents_agent ON pending_intents(agent_id);
      CREATE INDEX idx_pending_intents_timestamp ON pending_intents(timestamp);
    `);
    db.prepare(
      'INSERT INTO pending_intents (id, agent_id, intent_type, target_files, expected_changes, timestamp, ttl_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('legacy-uuid-1', 'agent-a', 'write', '["src/a.ts"]', '{"notes":["change sig"]}', 1000, 300);
    db.prepare(
      'INSERT INTO pending_intents (id, agent_id, intent_type, target_files, expected_changes, timestamp, ttl_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('legacy-uuid-2', 'agent-b', 'refactor', null, null, null, null);
    setSchemaVersion(db, 92, 'add_pattern_origin_and_collaboration');

    runMigrations(db);

    expect(getCurrentSchemaVersion(db)).toBe(95);

    // Canonical column set + INTEGER timestamp types.
    const cols = tableInfo(db);
    expect(cols.map((c) => c.name).sort()).toEqual([...CANONICAL_COLUMNS].sort());
    expect(cols.find((c) => c.name === 'expires_at')?.type.toUpperCase()).toBe('INTEGER');
    expect(cols.find((c) => c.name === 'broadcast_at')?.type.toUpperCase()).toBe('INTEGER');
    expect(cols.find((c) => c.name === 'id')?.type.toUpperCase()).toBe('INTEGER');

    // Row 1: expires_at = (timestamp + ttl_seconds) * 1000, broadcast_at = timestamp * 1000.
    const row1 = db
      .prepare('SELECT * FROM pending_intents WHERE agent_id = ?')
      .get('agent-a') as Record<string, unknown>;
    expect(row1.expires_at).toBe(1300 * 1000);
    expect(row1.broadcast_at).toBe(1000 * 1000);
    expect(row1.target_files).toBe('["src/a.ts"]');
    expect(row1.expected_changes).toBe('{"notes":["change sig"]}');
    expect(typeof row1.id).toBe('number'); // ids regenerated via autoincrement

    // Row 2: NULL timestamp/ttl → expires_at falls back to 0 (expired).
    const row2 = db
      .prepare('SELECT * FROM pending_intents WHERE agent_id = ?')
      .get('agent-b') as Record<string, unknown>;
    expect(row2.expires_at).toBe(0);
    expect(row2.broadcast_at).toBe(0);
    expect(row2.target_files).toBe('[]');

    // Canonical indexes exist (agent + type); stale timestamp index is gone.
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pending_intents'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_pending_intents_agent');
    expect(names).toContain('idx_pending_intents_type');
    expect(names).not.toContain('idx_pending_intents_timestamp');
    db.close();
  });

  it('is a no-op on a fresh canonical database', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    const before = db
      .prepare('SELECT * FROM pending_intents')
      .all();
    // Canonical shape already — insert one runtime-style row.
    db.prepare(
      `INSERT INTO pending_intents (agent_id, intent_type, target_files, broadcast_at, expires_at) VALUES (?, ?, ?, ?, ?)`
    ).run('agent-c', 'read', '["src/c.ts"]', 5000, 305000);

    setSchemaVersion(db, 92, 'add_pattern_origin_and_collaboration');
    runMigrations(db);

    expect(getCurrentSchemaVersion(db)).toBe(95);
    const row = db
      .prepare('SELECT * FROM pending_intents WHERE agent_id = ?')
      .get('agent-c') as Record<string, unknown>;
    expect(row.expires_at).toBe(305000); // untouched integer unix-ms
    expect(row.broadcast_at).toBe(5000);
    expect(tableInfo(db).map((c) => c.name).sort()).toEqual([...CANONICAL_COLUMNS].sort());
    expect(before.length).toBe(0);
    db.close();
  });

  it('converts TEXT datetime/ISO expires_at values to integer unix-ms', () => {
    const db = new DatabaseSync(':memory:');
    // schema.ts shape but with TEXT timestamp columns (legacy datetime rows).
    db.exec(`
      CREATE TABLE pending_intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        intent_type TEXT NOT NULL CHECK(intent_type IN ('read','write','refactor','delete')),
        target_files TEXT NOT NULL,
        session_id TEXT,
        description TEXT,
        expected_changes TEXT,
        broadcast_at TEXT,
        expires_at TEXT
      );
      CREATE INDEX idx_pending_intents_agent ON pending_intents(agent_id);
      CREATE INDEX idx_pending_intents_type ON pending_intents(intent_type);
    `);
    const expectedMs = Date.parse('2026-01-01T00:00:00Z'); // 1767225600000
    db.prepare(
      'INSERT INTO pending_intents (agent_id, intent_type, target_files, broadcast_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run('agent-d', 'write', '["src/d.ts"]', '2025-12-31 23:55:00', '2026-01-01 00:00:00');
    db.prepare(
      'INSERT INTO pending_intents (agent_id, intent_type, target_files, broadcast_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run('agent-e', 'refactor', '["src/e.ts"]', '2025-12-31T23:55:00.000Z', '2026-01-01T00:00:00Z');
    db.prepare(
      'INSERT INTO pending_intents (agent_id, intent_type, target_files, broadcast_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run('agent-f', 'delete', '["src/f.ts"]', 'not-a-timestamp', 'garbage-value');
    setSchemaVersion(db, 92, 'add_pattern_origin_and_collaboration');

    runMigrations(db);

    expect(getCurrentSchemaVersion(db)).toBe(95);
    const cols = tableInfo(db);
    expect(cols.find((c) => c.name === 'expires_at')?.type.toUpperCase()).toBe('INTEGER');
    expect(cols.find((c) => c.name === 'broadcast_at')?.type.toUpperCase()).toBe('INTEGER');

    // 'YYYY-MM-DD HH:MM:SS' row → strftime seconds * 1000.
    const rowD = db.prepare('SELECT * FROM pending_intents WHERE agent_id = ?').get('agent-d') as Record<string, unknown>;
    expect(rowD.expires_at).toBe(expectedMs);
    expect(rowD.broadcast_at).toBe(Date.parse('2025-12-31T23:55:00Z'));

    // ISO 'T'/'Z' row → parsed by strftime as well.
    const rowE = db.prepare('SELECT * FROM pending_intents WHERE agent_id = ?').get('agent-e') as Record<string, unknown>;
    expect(rowE.expires_at).toBe(expectedMs);

    // Unparseable strings → 0 (treated as expired, never crash).
    const rowF = db.prepare('SELECT * FROM pending_intents WHERE agent_id = ?').get('agent-f') as Record<string, unknown>;
    expect(rowF.expires_at).toBe(0);
    expect(rowF.broadcast_at).toBe(0);

    // Indexes preserved through the rebuild.
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pending_intents'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_pending_intents_agent');
    expect(names).toContain('idx_pending_intents_type');
    db.close();
  });

  it('fixes TEXT values in-place when the column type is already INTEGER', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE pending_intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        intent_type TEXT NOT NULL CHECK(intent_type IN ('read','write','refactor','delete')),
        target_files TEXT NOT NULL,
        session_id TEXT,
        description TEXT,
        expected_changes TEXT,
        broadcast_at INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    // INTEGER affinity keeps unconvertible strings as TEXT — legacy rows.
    db.exec(
      `INSERT INTO pending_intents (agent_id, intent_type, target_files, broadcast_at, expires_at)
       VALUES ('agent-g', 'write', '["src/g.ts"]', '2025-12-31 23:55:00', '2026-01-01 00:00:00')`
    );
    setSchemaVersion(db, 92, 'add_pattern_origin_and_collaboration');

    runMigrations(db);

    expect(getCurrentSchemaVersion(db)).toBe(95);
    const row = db.prepare('SELECT * FROM pending_intents WHERE agent_id = ?').get('agent-g') as Record<string, unknown>;
    expect(row.expires_at).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(row.broadcast_at).toBe(Date.parse('2025-12-31T23:55:00Z'));
    db.close();
  });

  it('disambiguates pure-numeric TEXT timestamps by digit count (≤10 digits = unix seconds)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE pending_intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        intent_type TEXT NOT NULL CHECK(intent_type IN ('read','write','refactor','delete')),
        target_files TEXT NOT NULL,
        session_id TEXT,
        description TEXT,
        expected_changes TEXT,
        broadcast_at TEXT,
        expires_at TEXT
      );
    `);
    // 10-digit numeric TEXT → unix SECONDS, must be scaled to ms.
    db.prepare(
      'INSERT INTO pending_intents (agent_id, intent_type, target_files, broadcast_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run('agent-sec', 'write', '["src/s.ts"]', '1767225600', '1767225900');
    // 13-digit numeric TEXT → already ms, must pass through unchanged.
    db.prepare(
      'INSERT INTO pending_intents (agent_id, intent_type, target_files, broadcast_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run('agent-ms', 'refactor', '["src/m.ts"]', '1767225600000', '1767225900000');
    setSchemaVersion(db, 92, 'add_pattern_origin_and_collaboration');

    runMigrations(db);

    expect(getCurrentSchemaVersion(db)).toBe(95);
    const rowSec = db.prepare('SELECT * FROM pending_intents WHERE agent_id = ?').get('agent-sec') as Record<string, unknown>;
    expect(rowSec.broadcast_at).toBe(1767225600 * 1000);
    expect(rowSec.expires_at).toBe(1767225900 * 1000);
    const rowMs = db.prepare('SELECT * FROM pending_intents WHERE agent_id = ?').get('agent-ms') as Record<string, unknown>;
    expect(rowMs.broadcast_at).toBe(1767225600000);
    expect(rowMs.expires_at).toBe(1767225900000);
    db.close();
  });

  it('converts the genuine shipped schema.ts shape (NO expected_changes) without losing rows', () => {
    // Regression: migration 93 used to reference expected_changes
    // unconditionally and aborted with "no such column: expected_changes"
    // on every pre-delivery database.
    const db = new DatabaseSync(':memory:');
    db.exec(GENUINE_OLD_SHAPE_DDL);
    db.prepare(
      'INSERT INTO pending_intents (agent_id, intent_type, target_files, session_id, description, broadcast_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('agent-old-1', 'write', '["src/old1.ts"]', 'sess-1', 'legacy row one', '2025-12-31 23:55:00', '2026-01-01 00:00:00');
    db.prepare(
      'INSERT INTO pending_intents (agent_id, intent_type, target_files, session_id, description, broadcast_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('agent-old-2', 'read', '["src/old2.ts"]', null, null, '2025-12-31 23:56:00', '2026-01-01 00:01:00');
    setSchemaVersion(db, 92, 'add_pattern_origin_and_collaboration');

    runMigrations(db);

    expect(getCurrentSchemaVersion(db)).toBe(95);
    const cols = tableInfo(db);
    expect(cols.map((c) => c.name).sort()).toEqual([...CANONICAL_COLUMNS].sort());
    expect(cols.find((c) => c.name === 'expires_at')?.type.toUpperCase()).toBe('INTEGER');
    expect(cols.find((c) => c.name === 'broadcast_at')?.type.toUpperCase()).toBe('INTEGER');

    // Both rows preserved with datetime strings converted to unix ms.
    const row1 = db.prepare('SELECT * FROM pending_intents WHERE agent_id = ?').get('agent-old-1') as Record<string, unknown>;
    expect(row1.target_files).toBe('["src/old1.ts"]');
    expect(row1.session_id).toBe('sess-1');
    expect(row1.description).toBe('legacy row one');
    expect(row1.expected_changes).toBeNull(); // column never existed pre-delivery
    expect(row1.broadcast_at).toBe(Date.parse('2025-12-31T23:55:00Z'));
    expect(row1.expires_at).toBe(Date.parse('2026-01-01T00:00:00Z'));

    const row2 = db.prepare('SELECT * FROM pending_intents WHERE agent_id = ?').get('agent-old-2') as Record<string, unknown>;
    expect(row2.expected_changes).toBeNull();
    expect(row2.expires_at).toBe(Date.parse('2026-01-01T00:01:00Z'));
    expect((db.prepare('SELECT COUNT(*) AS n FROM pending_intents').get() as { n: number }).n).toBe(2);
    db.close();
  });

  it('runs v92 else-branch + v93 on the genuine old shape (populated table)', () => {
    // Regression for the v92 ADD COLUMN timestamp DEFAULT (strftime(...)):
    // SQLite rejects non-constant defaults once the table holds rows, which
    // permanently bricked the database. Version is set pre-92 so BOTH
    // migrations run against the populated genuine shape. Since the shape
    // already has expires_at, v92's else-branch must NOT add the legacy
    // timestamp column (canonical-marker skip); v93 then rebuilds canonical.
    const db = new DatabaseSync(':memory:');
    db.exec(GENUINE_OLD_SHAPE_DDL);
    db.prepare(
      'INSERT INTO pending_intents (agent_id, intent_type, target_files, session_id, description, broadcast_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('agent-combo', 'write', '["src/combo.ts"]', null, null, '2025-12-31 23:55:00', '2026-01-01 00:00:00');
    setSchemaVersion(db, 11, 'circular_dependencies_unique');

    expect(() => runMigrations(db)).not.toThrow();

    expect(getCurrentSchemaVersion(db)).toBe(95);
    expect(tableInfo(db).map((c) => c.name).sort()).toEqual([...CANONICAL_COLUMNS].sort());
    const row = db.prepare('SELECT * FROM pending_intents WHERE agent_id = ?').get('agent-combo') as Record<string, unknown>;
    expect(row.target_files).toBe('["src/combo.ts"]');
    expect(row.expected_changes).toBeNull();
    expect(row.broadcast_at).toBe(Date.parse('2025-12-31T23:55:00Z'));
    expect(row.expires_at).toBe(Date.parse('2026-01-01T00:00:00Z'));
    db.close();
  });

  it('converts a populated genuine v92 table created by migration 92 itself', () => {
    // No hand-written v92 DDL: migration 92 creates the table with its own
    // genuine DDL (VARCHAR(36) id, seconds timestamp, ttl_seconds,
    // expected_changes), rows are inserted, then migration 93 reconciles.
    const db = new DatabaseSync(':memory:');
    setSchemaVersion(db, 11, 'circular_dependencies_unique');
    const v92 = migrations.find((m) => m.version === 92);
    expect(v92).toBeDefined();
    v92!.up(db);
    setSchemaVersion(db, 92, v92!.name);
    db.prepare(
      'INSERT INTO pending_intents (id, agent_id, intent_type, target_files, expected_changes, timestamp, ttl_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('genuine-v92-1', 'agent-v92', 'write', '["src/v92.ts"]', '{"add":["param"]}', 1767225600, 300);

    runMigrations(db); // only v93 + v94 pending

    expect(getCurrentSchemaVersion(db)).toBe(95);
    expect(tableInfo(db).map((c) => c.name).sort()).toEqual([...CANONICAL_COLUMNS].sort());
    const row = db.prepare('SELECT * FROM pending_intents WHERE agent_id = ?').get('agent-v92') as Record<string, unknown>;
    expect(row.broadcast_at).toBe(1767225600 * 1000);
    expect(row.expires_at).toBe((1767225600 + 300) * 1000);
    expect(row.expected_changes).toBe('{"add":["param"]}');
    expect(row.target_files).toBe('["src/v92.ts"]');
    db.close();
  });

  it('handles an empty genuine old-shape table', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(GENUINE_OLD_SHAPE_DDL);
    setSchemaVersion(db, 92, 'add_pattern_origin_and_collaboration');

    runMigrations(db);

    expect(getCurrentSchemaVersion(db)).toBe(95);
    expect(tableInfo(db).map((c) => c.name).sort()).toEqual([...CANONICAL_COLUMNS].sort());
    expect((db.prepare('SELECT COUNT(*) AS n FROM pending_intents').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('regenerates ids when a legacy table contains duplicate ids', () => {
    // Hand-repaired legacy shape: id without a uniqueness constraint (so
    // duplicate ids can exist) and no expected_changes column. The rebuild
    // must not copy ids — duplicates survive as separate rows with fresh
    // AUTOINCREMENT ids, and the missing expected_changes is gated to NULL.
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE pending_intents (
        id TEXT,
        agent_id TEXT NOT NULL,
        intent_type TEXT NOT NULL,
        target_files TEXT,
        timestamp INTEGER,
        ttl_seconds INTEGER
      );
    `);
    db.prepare('INSERT INTO pending_intents (id, agent_id, intent_type, target_files, timestamp, ttl_seconds) VALUES (?, ?, ?, ?, ?, ?)')
      .run('dup-id', 'agent-dup-1', 'write', '["src/dup1.ts"]', 2000, 300);
    db.prepare('INSERT INTO pending_intents (id, agent_id, intent_type, target_files, timestamp, ttl_seconds) VALUES (?, ?, ?, ?, ?, ?)')
      .run('dup-id', 'agent-dup-2', 'refactor', '["src/dup2.ts"]', 3000, 60);
    setSchemaVersion(db, 92, 'add_pattern_origin_and_collaboration');

    runMigrations(db);

    expect(getCurrentSchemaVersion(db)).toBe(95);
    const rows = db.prepare('SELECT id, agent_id, expected_changes FROM pending_intents ORDER BY agent_id').all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(2);
    expect(rows[0].agent_id).toBe('agent-dup-1');
    expect(rows[1].agent_id).toBe('agent-dup-2');
    expect(typeof rows[0].id).toBe('number');
    expect(rows[0].id).not.toBe(rows[1].id); // ids regenerated — no UNIQUE collision
    expect(rows[0].expected_changes).toBeNull();
    expect(rows[1].expected_changes).toBeNull();
    db.close();
  });

  it('maps unparseable legacy datetime values to 0 (expired) on the genuine old shape', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(GENUINE_OLD_SHAPE_DDL);
    db.prepare(
      'INSERT INTO pending_intents (agent_id, intent_type, target_files, broadcast_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run('agent-garbage', 'delete', '["src/garbage.ts"]', 'not-a-timestamp', 'garbage-value');
    setSchemaVersion(db, 92, 'add_pattern_origin_and_collaboration');

    runMigrations(db);

    expect(getCurrentSchemaVersion(db)).toBe(95);
    const row = db.prepare('SELECT * FROM pending_intents WHERE agent_id = ?').get('agent-garbage') as Record<string, unknown>;
    expect(row.expires_at).toBe(0);
    expect(row.broadcast_at).toBe(0);
    expect(row.expected_changes).toBeNull();
    db.close();
  });

  it('drops NULL agent_id junk rows instead of bricking on the NOT NULL constraint', () => {
    // Hand-repaired legacy table with NULLABLE agent_id: the rebuild INSERT
    // used to hit "NOT NULL constraint failed: pending_intents_new.agent_id"
    // and make the whole DB unopenable.
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE pending_intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT,
        intent_type TEXT NOT NULL CHECK(intent_type IN ('read','write','refactor','delete')),
        target_files TEXT NOT NULL,
        session_id TEXT,
        description TEXT,
        expected_changes TEXT,
        broadcast_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL DEFAULT (datetime('now', '+5 minutes'))
      );
    `);
    db.prepare(
      'INSERT INTO pending_intents (agent_id, intent_type, target_files, broadcast_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(null, 'write', '["src/junk.ts"]', '2025-12-31 23:55:00', '2026-01-01 00:00:00');
    db.prepare(
      'INSERT INTO pending_intents (agent_id, intent_type, target_files, broadcast_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run('agent-valid', 'write', '["src/valid.ts"]', '2025-12-31 23:55:00', '2026-01-01 00:00:00');
    setSchemaVersion(db, 92, 'add_pattern_origin_and_collaboration');

    expect(() => runMigrations(db)).not.toThrow();

    expect(getCurrentSchemaVersion(db)).toBe(95);
    const rows = db.prepare('SELECT agent_id FROM pending_intents').all() as Array<{ agent_id: string | null }>;
    expect(rows).toHaveLength(1); // junk row dropped…
    expect(rows[0].agent_id).toBe('agent-valid'); // …valid row kept
    db.close();
  });

  it('fresh install (SCHEMA_SQL then migrations from v0) leaves no junk timestamp column', () => {
    // Real init order: SCHEMA_SQL creates the canonical pending_intents
    // FIRST, then migrations run from version 0. The v92 else-branch used to
    // ADD COLUMN timestamp + index on top of the canonical table and v93
    // no-opped, leaving permanent junk.
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);

    expect(() => runMigrations(db)).not.toThrow();

    expect(getCurrentSchemaVersion(db)).toBe(95);
    // Final table matches schema.ts columns EXACTLY (no timestamp).
    expect(tableInfo(db).map((c) => c.name).sort()).toEqual([...CANONICAL_COLUMNS].sort());
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pending_intents'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).not.toContain('idx_pending_intents_timestamp');
    db.close();
  });

  it('v93 canonical no-op removes a stray legacy timestamp column and its index', () => {
    // Simulates a pre-fix fresh install: canonical table plus the junk
    // timestamp column + index that v92's else-branch added.
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    db.exec('ALTER TABLE pending_intents ADD COLUMN timestamp INTEGER DEFAULT 0;');
    db.exec('CREATE INDEX idx_pending_intents_timestamp ON pending_intents(timestamp);');
    db.prepare(
      'INSERT INTO pending_intents (agent_id, intent_type, target_files, broadcast_at, expires_at, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('agent-stray', 'write', '["src/stray.ts"]', 5000, 305000, 5);
    setSchemaVersion(db, 92, 'add_pattern_origin_and_collaboration');

    runMigrations(db);

    expect(getCurrentSchemaVersion(db)).toBe(95);
    expect(tableInfo(db).map((c) => c.name).sort()).toEqual([...CANONICAL_COLUMNS].sort());
    const row = db.prepare('SELECT * FROM pending_intents WHERE agent_id = ?').get('agent-stray') as Record<string, unknown>;
    expect(row.expires_at).toBe(305000); // row data untouched
    expect(row.broadcast_at).toBe(5000);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pending_intents'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).not.toContain('idx_pending_intents_timestamp');
    db.close();
  });

  it('UPDATE branch adds a missing broadcast_at column (converges with rebuild)', () => {
    // INTEGER expires_at column holding legacy TEXT values → in-place UPDATE
    // path. Tables without broadcast_at used to stay without it forever on
    // this branch while the rebuild branch added it.
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE pending_intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        intent_type TEXT NOT NULL CHECK(intent_type IN ('read','write','refactor','delete')),
        target_files TEXT NOT NULL,
        session_id TEXT,
        description TEXT,
        expected_changes TEXT,
        expires_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.exec(
      `INSERT INTO pending_intents (agent_id, intent_type, target_files, expires_at)
       VALUES ('agent-nb', 'write', '["src/nb.ts"]', '2026-01-01 00:00:00')`
    );
    setSchemaVersion(db, 92, 'add_pattern_origin_and_collaboration');

    runMigrations(db);

    expect(getCurrentSchemaVersion(db)).toBe(95);
    const cols = tableInfo(db);
    expect(cols.map((c) => c.name)).toContain('broadcast_at');
    const row = db.prepare('SELECT * FROM pending_intents WHERE agent_id = ?').get('agent-nb') as Record<string, unknown>;
    expect(row.expires_at).toBe(Date.parse('2026-01-01T00:00:00Z')); // TEXT value converted
    expect(row.broadcast_at).toBe(0); // unknown → 0, same as rebuild fallback
    db.close();
  });
});

describe('Migration 94 — debt_items change_frequency + project_id backfill', () => {
  it('inserts and reads back a change_frequency debt item after upgrading a v93 DB', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO files (path, relative_path, language) VALUES (?, ?, ?)')
      .run('src/hot.ts', 'src/hot.ts', 'typescript');
    // Simulate a pre-existing DB stamped at v93 whose debt_items still carries
    // the OLD 7-type CHECK (migration 7's rebuild shape) — v94 must widen it.
    db.exec(`
      CREATE TABLE debt_items_legacy (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER,
        type TEXT CHECK(type IN ('pattern_drift', 'architectural_drift', 'redundancy', 'agent_conflict', 'complexity', 'code_age', 'cognitive_load')),
        description TEXT,
        severity TEXT CHECK(severity IN ('high', 'medium', 'low')),
        suggestion TEXT,
        reasoning_trace TEXT,
        detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        resolved BOOLEAN DEFAULT 0,
        resolved_at TIMESTAMP,
        FOREIGN KEY (file_id) REFERENCES files(id)
      );
      INSERT INTO debt_items_legacy (file_id, type, description, severity) VALUES (1, 'complexity', 'legacy debt', 'high');
      DROP TABLE debt_items;
      ALTER TABLE debt_items_legacy RENAME TO debt_items;
    `);
    setSchemaVersion(db, 93, 'pending_intents_unix_ms');

    runMigrations(db); // only v94 pending

    expect(getCurrentSchemaVersion(db)).toBe(95);

    // The new type is accepted and round-trips through the rebuilt table.
    db.prepare('INSERT INTO debt_items (file_id, type, description, severity, suggestion) VALUES (?, ?, ?, ?, ?)')
      .run(1, 'change_frequency', 'file changes very often', 'medium', 'stabilize module');
    const row = db.prepare('SELECT type, description, severity, suggestion FROM debt_items WHERE type = ?')
      .get('change_frequency') as { type: string; description: string; severity: string; suggestion: string };
    expect(row.type).toBe('change_frequency');
    expect(row.description).toBe('file changes very often');
    expect(row.severity).toBe('medium');
    expect(row.suggestion).toBe('stabilize module');

    // The legacy row survived the rebuild.
    const legacy = db.prepare('SELECT description FROM debt_items WHERE type = ?').get('complexity') as { description: string };
    expect(legacy.description).toBe('legacy debt');
    db.close();
  });

  it('backfills project_id on files and data_flows of a pre-existing DB', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    // SCHEMA_SQL declares files/data_flows WITHOUT project_id — a DB stamped
    // at v93 here simulates one that never received migration 3's ALTER.
    setSchemaVersion(db, 93, 'pending_intents_unix_ms');

    runMigrations(db); // only v94 pending

    expect(getCurrentSchemaVersion(db)).toBe(95);
    const filesCols = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
    expect(filesCols.some((c) => c.name === 'project_id')).toBe(true);
    const dataFlowsCols = db.prepare('PRAGMA table_info(data_flows)').all() as Array<{ name: string }>;
    expect(dataFlowsCols.some((c) => c.name === 'project_id')).toBe(true);
    db.close();
  });
});

describe('Migration 95 — FK cascades + imports resolved_path index', () => {
  /** Minimal parent tables + the three child tables with NON-cascading FKs. */
  function createLegacyV94Db(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        relative_path TEXT NOT NULL,
        language TEXT
      );
      CREATE TABLE patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        code_hash TEXT NOT NULL
      );
      CREATE TABLE pattern_violations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_id INTEGER NOT NULL,
        file_id INTEGER NOT NULL,
        line_number INTEGER,
        severity TEXT CHECK(severity IN ('high', 'medium', 'low')),
        detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        resolved BOOLEAN DEFAULT 0,
        FOREIGN KEY (pattern_id) REFERENCES patterns(id),
        FOREIGN KEY (file_id) REFERENCES files(id)
      );
      CREATE TABLE coherence_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER,
        code_hash TEXT NOT NULL,
        verdict TEXT CHECK(verdict IN ('pass', 'warn', 'fail')),
        confidence REAL,
        reasoning_trace TEXT,
        suggestions TEXT,
        analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        llm_provider TEXT,
        response_time_ms INTEGER,
        FOREIGN KEY (file_id) REFERENCES files(id)
      );
      CREATE TABLE debt_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER,
        type TEXT CHECK(type IN ('pattern_drift', 'architectural_drift', 'redundancy', 'agent_conflict', 'complexity', 'code_age', 'cognitive_load', 'change_frequency')),
        description TEXT,
        severity TEXT CHECK(severity IN ('high', 'medium', 'low')),
        suggestion TEXT,
        reasoning_trace TEXT,
        detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        resolved BOOLEAN DEFAULT 0,
        resolved_at TIMESTAMP,
        FOREIGN KEY (file_id) REFERENCES files(id)
      );
      CREATE TABLE imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        kind TEXT,
        resolved BOOLEAN DEFAULT 0,
        resolved_path TEXT
      );
    `);
    setSchemaVersion(db, 94, 'debt_change_frequency_and_project_id_backfill');
    return db;
  }

  function seedParentAndChildren(db: DatabaseSync): { fileId: number; patternId: number } {
    db.prepare('INSERT INTO files (path, relative_path, language) VALUES (?, ?, ?)').run('src/gone.ts', 'src/gone.ts', 'typescript');
    db.prepare('INSERT INTO patterns (name, category, code_hash) VALUES (?, ?, ?)').run('p1', 'style', 'hash-1');
    const fileId = Number((db.prepare('SELECT id FROM files WHERE path = ?').get('src/gone.ts') as { id: number }).id);
    const patternId = Number((db.prepare('SELECT id FROM patterns WHERE name = ?').get('p1') as { id: number }).id);
    db.prepare('INSERT INTO pattern_violations (pattern_id, file_id, line_number, severity) VALUES (?, ?, ?, ?)').run(patternId, fileId, 10, 'high');
    db.prepare('INSERT INTO coherence_decisions (file_id, code_hash, verdict) VALUES (?, ?, ?)').run(fileId, 'hash-1', 'warn');
    db.prepare('INSERT INTO debt_items (file_id, type, severity) VALUES (?, ?, ?)').run(fileId, 'complexity', 'medium');
    return { fileId, patternId };
  }

  it('legacy v94 DB: deleting a file cascades to violations/decisions/debt after migration 95', () => {
    const db = createLegacyV94Db();
    const { fileId, patternId } = seedParentAndChildren(db);

    runMigrations(db); // only v95 pending

    expect(getCurrentSchemaVersion(db)).toBe(95);

    // Rows survive the rebuild itself.
    expect((db.prepare('SELECT COUNT(*) AS n FROM pattern_violations').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM coherence_decisions').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM debt_items').get() as { n: number }).n).toBe(1);

    db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pattern_violations WHERE file_id = ?').get(fileId) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM coherence_decisions WHERE file_id = ?').get(fileId) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM debt_items WHERE file_id = ?').get(fileId) as { n: number }).n).toBe(0);

    // Deleting a pattern cascades its violations too.
    db.prepare('INSERT INTO files (path, relative_path, language) VALUES (?, ?, ?)').run('src/kept.ts', 'src/kept.ts', 'typescript');
    const keptFileId = Number((db.prepare('SELECT id FROM files WHERE path = ?').get('src/kept.ts') as { id: number }).id);
    db.prepare('INSERT INTO pattern_violations (pattern_id, file_id, line_number, severity) VALUES (?, ?, ?, ?)').run(patternId, keptFileId, 3, 'low');
    db.prepare('DELETE FROM patterns WHERE id = ?').run(patternId);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pattern_violations WHERE pattern_id = ?').get(patternId) as { n: number }).n).toBe(0);
    db.close();
  });

  it('fresh SCHEMA_SQL DB: cascades work end to end', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA_SQL);

    runMigrations(db);

    expect(getCurrentSchemaVersion(db)).toBe(95);
    const { fileId } = seedParentAndChildren(db);

    db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pattern_violations WHERE file_id = ?').get(fileId) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM coherence_decisions WHERE file_id = ?').get(fileId) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM debt_items WHERE file_id = ?').get(fileId) as { n: number }).n).toBe(0);
    db.close();
  });

  it('creates idx_imports_resolved_path', () => {
    const db = createLegacyV94Db();

    runMigrations(db);

    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_imports_resolved_path'")
      .get();
    expect(idx).toBeDefined();
    db.close();
  });
});
