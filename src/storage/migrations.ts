import { DatabaseSync } from 'node:sqlite';
import { logger } from '../utils/logger.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
  down?: (db: DatabaseSync) => void;
}

const SCHEMA_VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: () => { /* Initial schema is applied via SCHEMA_SQL */ },
    down: () => { /* Cannot rollback initial schema */ },
  },
  {
    version: 2,
    name: 'add_calls_table',
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_function_id INTEGER NOT NULL,
          to_function_id INTEGER NOT NULL,
          dynamic BOOLEAN DEFAULT 0,
          static_missed BOOLEAN DEFAULT 0,
          call_count INTEGER DEFAULT 1,
          workload_id TEXT,
          detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (from_function_id) REFERENCES functions(id) ON DELETE CASCADE,
          FOREIGN KEY (to_function_id) REFERENCES functions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_calls_from ON calls(from_function_id);
        CREATE INDEX IF NOT EXISTS idx_calls_to ON calls(to_function_id);
        CREATE INDEX IF NOT EXISTS idx_calls_dynamic ON calls(dynamic);
        CREATE INDEX IF NOT EXISTS idx_calls_workload ON calls(workload_id);
      `);
    },
    down: (db: DatabaseSync) => {
      db.exec('DROP TABLE IF EXISTS calls;');
    },
  },
  {
    version: 3,
    name: 'add_projects_and_data_flow',
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          root_path TEXT NOT NULL,
          description TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_scanned TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      const filesColumns = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
      const hasProjectId = filesColumns.some(c => c.name === 'project_id');

      if (!hasProjectId) {
        db.exec('ALTER TABLE files ADD COLUMN project_id INTEGER DEFAULT 1');
        db.exec('UPDATE files SET project_id = 1 WHERE project_id IS NULL');
      }

      db.exec('CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);');

      db.exec(`
        CREATE TABLE IF NOT EXISTS resources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          qualified_name TEXT UNIQUE NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('FILE', 'NETWORK', 'DATABASE', 'ENV', 'STDIN', 'STDOUT', 'STDERR', 'SOCKET')),
          identity TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS data_flows (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_resource_id INTEGER NOT NULL,
          to_resource_id INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('resource', 'arg', 'return')),
          via TEXT,
          source_function_id INTEGER,
          target_function_id INTEGER,
          detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (from_resource_id) REFERENCES resources(id) ON DELETE CASCADE,
          FOREIGN KEY (to_resource_id) REFERENCES resources(id) ON DELETE CASCADE,
          FOREIGN KEY (source_function_id) REFERENCES functions(id) ON DELETE SET NULL,
          FOREIGN KEY (target_function_id) REFERENCES functions(id) ON DELETE SET NULL
        );
      `);

      const dataFlowsColumns = db.prepare("PRAGMA table_info(data_flows)").all() as Array<{ name: string }>;
      const hasProjectIdDataFlows = dataFlowsColumns.some(c => c.name === 'project_id');

      if (!hasProjectIdDataFlows) {
        db.exec('ALTER TABLE data_flows ADD COLUMN project_id INTEGER DEFAULT 1');
        db.exec('UPDATE data_flows SET project_id = 1 WHERE project_id IS NULL');
      }

      db.exec('CREATE INDEX IF NOT EXISTS idx_resources_qualified ON resources(qualified_name);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_data_flows_project ON data_flows(project_id);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_data_flows_from ON data_flows(from_resource_id);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_data_flows_to ON data_flows(to_resource_id);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_data_flows_kind ON data_flows(kind);');
    },
    down: (db: DatabaseSync) => {
      db.exec('DROP TABLE IF EXISTS data_flows;');
      db.exec('DROP TABLE IF EXISTS resources;');
      db.exec('DROP INDEX IF EXISTS idx_files_project;');
      // Note: SQLite doesn't support DROP COLUMN, so project_id in files remains
    },
  },
  {
    version: 4,
    name: 'add_settings_table',
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
    down: (db: DatabaseSync) => {
      db.exec('DROP TABLE IF EXISTS settings;');
    },
  },
  {
    version: 5,
    name: 'add_team_memories_table',
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS team_memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_name TEXT NOT NULL,
          scope TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          is_public BOOLEAN DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_team_memories_scope ON team_memories(scope);
        CREATE INDEX IF NOT EXISTS idx_team_memories_agent ON team_memories(agent_name);
      `);
    },
    down: (db: DatabaseSync) => {
      db.exec('DROP TABLE IF EXISTS team_memories;');
    },
  },
  {
    version: 6,
    name: 'team_memories_unique_scope_key',
    up: (db: DatabaseSync) => {
      // Databases created by migration v5 lack the UNIQUE(scope, key)
      // constraint declared in SCHEMA_SQL, which storeTeamMemory's
      // upsert relies on ("ON CONFLICT clause does not match..." error).
      // SQLite cannot ADD CONSTRAINT — rebuild the table:
      // dedupe (keep newest updated_at), recreate with constraint, copy back.
      db.exec(`
        CREATE TABLE IF NOT EXISTS team_memories_migrated (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_name TEXT NOT NULL,
          scope TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          is_public BOOLEAN DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(scope, key)
        );
        INSERT OR REPLACE INTO team_memories_migrated (id, agent_name, scope, key, value, is_public, created_at, updated_at)
          SELECT id, agent_name, scope, key, value, is_public, created_at, updated_at FROM team_memories
          WHERE id IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (PARTITION BY scope, key ORDER BY updated_at DESC, id DESC) AS rn FROM team_memories
            ) WHERE rn = 1
          );
        DROP TABLE team_memories;
        ALTER TABLE team_memories_migrated RENAME TO team_memories;
        CREATE INDEX IF NOT EXISTS idx_team_memories_scope ON team_memories(scope);
        CREATE INDEX IF NOT EXISTS idx_team_memories_agent ON team_memories(agent_name);
      `);
    },
    down: (db: DatabaseSync) => {
      // Cannot restore pre-constraint duplicates; keep data as-is.
      void db;
    },
  },
  {
    version: 7,
    name: 'add_last_synced_and_expand_debt_types',
    up: (db: DatabaseSync) => {
      // 1. Add last_synced column to files table if missing.
      //    SQLite forbids non-constant defaults (CURRENT_TIMESTAMP) in
      //    ALTER TABLE ADD COLUMN — leave the column nullable instead; read
      //    sites already fall back to last_scanned when last_synced is NULL
      //    (src/storage/kg/helpers/files.ts, imports.ts), and graph.ts sets
      //    last_synced on the next sync.
      const filesColumns = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
      const hasLastSynced = filesColumns.some(c => c.name === 'last_synced');
      if (!hasLastSynced) {
        db.exec('ALTER TABLE files ADD COLUMN last_synced TIMESTAMP');
      }

      // 2. Rebuild debt_items table to expand the type CHECK constraint
      //    from 4 types to 7 (adding 'complexity', 'code_age', 'cognitive_load').
      //    SQLite cannot ALTER a CHECK constraint, so rebuild is required.
      db.exec(`
        CREATE TABLE IF NOT EXISTS debt_items_migrated (
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
        INSERT INTO debt_items_migrated (id, file_id, type, description, severity, suggestion, reasoning_trace, detected_at, resolved, resolved_at)
          SELECT id, file_id, type, description, severity, suggestion, reasoning_trace, detected_at, resolved, resolved_at FROM debt_items;
        DROP TABLE debt_items;
        ALTER TABLE debt_items_migrated RENAME TO debt_items;
      `);

      // Recreate indexes that were on debt_items
      db.exec('CREATE INDEX IF NOT EXISTS idx_debt_resolved ON debt_items(resolved);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_debt_items_type ON debt_items(type, severity);');
    },
    down: (db: DatabaseSync) => {
      // Rebuild debt_items back to the 4-type constraint
      db.exec(`
        CREATE TABLE IF NOT EXISTS debt_items_old (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_id INTEGER,
          type TEXT CHECK(type IN ('pattern_drift', 'architectural_drift', 'redundancy', 'agent_conflict')),
          description TEXT,
          severity TEXT CHECK(severity IN ('high', 'medium', 'low')),
          suggestion TEXT,
          reasoning_trace TEXT,
          detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          resolved BOOLEAN DEFAULT 0,
          resolved_at TIMESTAMP,
          FOREIGN KEY (file_id) REFERENCES files(id)
        );
        INSERT INTO debt_items_old (id, file_id, type, description, severity, suggestion, reasoning_trace, detected_at, resolved, resolved_at)
          SELECT id, file_id, type, description, severity, suggestion, reasoning_trace, detected_at, resolved, resolved_at FROM debt_items WHERE type IN ('pattern_drift', 'architectural_drift', 'redundancy', 'agent_conflict');
        DROP TABLE debt_items;
        ALTER TABLE debt_items_old RENAME TO debt_items;
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_debt_resolved ON debt_items(resolved);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_debt_items_type ON debt_items(type, severity);');
      // Note: last_synced column is not removed (SQLite limitation)
    },
  },
{
    version: 8,
    name: 'team_memories_base_value',
    up: (db: DatabaseSync) => {
      // 3-way merge support for team memories: base_value records the value
      // that was current BEFORE the stored one, enabling Git-style
      // base/local/remote merges instead of last-write-wins.
      const columns = db.prepare('PRAGMA table_info(team_memories)').all() as Array<{ name: string }>;
      const hasBaseValue = columns.some((c) => c.name === 'base_value');
      if (!hasBaseValue) {
        db.exec('ALTER TABLE team_memories ADD COLUMN base_value TEXT');
      }
    },
    down: (db: DatabaseSync) => {
      // SQLite cannot drop columns without a table rebuild; leaving the
      // nullable column in place is safe for rollback.
      void db;
    },
  },
{
    version: 9,
    name: 'add_oauth_persistence',
    up: (db: DatabaseSync) => {
      // OAuth 2.0 (RFC 7591 / RFC 6749) persistence: dynamic client
      // registrations and bearer access tokens move out of RAM (Map) into
      // SQLite so authorizations survive server restarts.
      //   oauth_clients: client_id PK, SHA-256 secret hash (never plaintext),
      //     metadata = JSON of ClientMetadata (RFC 7591 §2 form), epoch seconds.
      //   oauth_tokens: opaque bearer token PK, FK to client, epoch ms timestamps.
      db.exec(`
        CREATE TABLE IF NOT EXISTS oauth_clients (
          client_id TEXT PRIMARY KEY,
          secret_hash TEXT,
          metadata TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS oauth_tokens (
          token TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          scope TEXT,
          issued_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
        CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens(expires_at);
      `);
    },
    down: (db: DatabaseSync) => {
      db.exec('DROP TABLE IF EXISTS oauth_tokens;');
      db.exec('DROP TABLE IF EXISTS oauth_clients;');
    },
  },
  {
    version: 10,
    name: 'hash_oauth_tokens',
    up: (db: DatabaseSync) => {
      // K6: bearer access tokens were persisted PLAINTEXT (prefix `pm_<hex>`).
      // A DB read (backup, crash dump, shared filesystem) leaked live
      // credentials. From here on `oauth_tokens.token` stores only
      // `sha256:<hex>` — the plaintext is returned to the client exactly once
      // at issuance and never written. Any reader of the DB file can no longer
      // mint requests.
      // Migration: existing plaintext rows cannot be re-hashed (the plaintext
      // is gone), so they are terminated — clients simply re-authenticate.
      db.exec("DELETE FROM oauth_tokens WHERE token NOT LIKE 'sha256:%'");
    },
    down: (db: DatabaseSync) => {
      // Irreversible by design: hashes cannot be turned back into tokens.
      void db;
    },
  },
  {
    version: 11,
    name: 'circular_dependencies_unique',
    up: (db: DatabaseSync) => {
      // K10: circular_dependencies had NO unique constraint, so the
      // `INSERT OR IGNORE` fast-path (imports.ts / import-repository.ts)
      // silently duplicated cycle rows forever. Dedupe (keep the earliest
      // row per cycle_path), then enforce uniqueness at the DB level.
      const hasTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'circular_dependencies'")
        .get();
      if (!hasTable) return; // pre-schema DB — SCHEMA_SQL creates the table fresh.
      db.exec(`
        DELETE FROM circular_dependencies
        WHERE id NOT IN (SELECT MIN(id) FROM circular_dependencies GROUP BY cycle_path);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_circular_deps_cycle_path
          ON circular_dependencies(cycle_path);
      `);
    },
    down: (db: DatabaseSync) => {
      db.exec('DROP INDEX IF EXISTS idx_circular_deps_cycle_path');
    },
  },
  {
    version: 92,
    name: 'add_pattern_origin_and_collaboration',
    up: (db: DatabaseSync) => {
      // Check if columns exist before adding (schema may already include them)
      const patternsCols = db.prepare("PRAGMA table_info(patterns)").all() as Array<{name: string}>;
      const teamCols = db.prepare("PRAGMA table_info(team_memories)").all() as Array<{name: string}>;
      if (!patternsCols.find(c => c.name === 'project_id')) {
        db.exec(`ALTER TABLE patterns ADD COLUMN project_id INTEGER;`);
      }
      if (!teamCols.find(c => c.name === 'project_id')) {
        db.exec(`ALTER TABLE team_memories ADD COLUMN project_id INTEGER;`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_patterns_project ON patterns(project_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_team_memories_project ON team_memories(project_id);`);
      // Ensure pending_intents table exists with correct schema
      const pendingExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pending_intents'").get();
      if (!pendingExists) {
        db.exec(`CREATE TABLE pending_intents (
          id VARCHAR(36) PRIMARY KEY,
          agent_id VARCHAR(255) NOT NULL,
          intent_type VARCHAR(20) NOT NULL,
          target_files TEXT,
          expected_changes TEXT,
          timestamp INTEGER DEFAULT (strftime('%s', 'now')),
          ttl_seconds INTEGER DEFAULT 300
        );`);
      } else {
        // If table exists but missing timestamp column, add it
        const pendingCols = db.prepare("PRAGMA table_info(pending_intents)").all() as Array<{name: string}>;
        if (!pendingCols.find(c => c.name === 'timestamp')) {
          db.exec(`ALTER TABLE pending_intents ADD COLUMN timestamp INTEGER DEFAULT (strftime('%s', 'now'));`);
        }
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_intents_agent ON pending_intents(agent_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_intents_timestamp ON pending_intents(timestamp);`);
    },
    down: (db: DatabaseSync) => {
      db.exec('DROP INDEX IF EXISTS idx_patterns_project;');
      db.exec('DROP INDEX IF EXISTS idx_team_memories_project;');
      db.exec('ALTER TABLE patterns DROP COLUMN project_id;');
      db.exec('ALTER TABLE team_memories DROP COLUMN project_id;');
      db.exec('DROP TABLE IF EXISTS pending_intents;');
    },
  },
];

export function getCurrentSchemaVersion(db: DatabaseSync): number {
  try {
    db.exec(SCHEMA_VERSION_TABLE);
    const result = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number | null } | undefined;
    return result?.version || 0;
  } catch {
    return 0;
  }
}

export function setSchemaVersion(db: DatabaseSync, version: number, name: string): void {
  db.exec(SCHEMA_VERSION_TABLE);
  db.prepare('INSERT OR REPLACE INTO schema_version (version, name) VALUES (?, ?)').run(version, name);
}

export function removeSchemaVersion(db: DatabaseSync, version: number): void {
  db.exec(SCHEMA_VERSION_TABLE);
  db.prepare('DELETE FROM schema_version WHERE version = ?').run(version);
}

/**
 * Run all pending migrations (up).
 */
export function runMigrations(db: DatabaseSync): void {
  const currentVersion = getCurrentSchemaVersion(db);
  logger.info(`Current schema version: ${currentVersion}`);

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      logger.info(`Applying migration ${migration.version}: ${migration.name}`);
      try {
        db.exec('BEGIN');
        migration.up(db);
        setSchemaVersion(db, migration.version, migration.name);
        db.exec('COMMIT');
        logger.info(`Migration ${migration.version} applied successfully`);
      } catch (error) {
        db.exec('ROLLBACK');
        logger.error(`Migration ${migration.version} failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }
  }

  const finalVersion = getCurrentSchemaVersion(db);
  logger.info(`Schema version after migrations: ${finalVersion}`);
}

/**
 * Rollback migrations to a specific target version.
 * Runs down() for all migrations with version > targetVersion, in reverse order.
 */
export function rollbackMigrations(db: DatabaseSync, targetVersion: number): void {
  const currentVersion = getCurrentSchemaVersion(db);
  
  if (targetVersion >= currentVersion) {
    logger.info(`Already at or below version ${targetVersion}. Nothing to rollback.`);
    return;
  }

  logger.info(`Rolling back from version ${currentVersion} to ${targetVersion}`);

  // Get all migrations that need to be rolled back (reverse order)
  const toRollback = migrations
    .filter(m => m.version <= currentVersion && m.version > targetVersion)
    .sort((a, b) => b.version - a.version);

  for (const migration of toRollback) {
    if (!migration.down) {
      throw new Error(`Cannot rollback migration ${migration.version}: ${migration.name} - no down() defined`);
    }
    
    logger.info(`Rolling back migration ${migration.version}: ${migration.name}`);
    try {
      db.exec('BEGIN');
      migration.down(db);
      removeSchemaVersion(db, migration.version);
      db.exec('COMMIT');
      logger.info(`Migration ${migration.version} rolled back successfully`);
    } catch (error) {
      db.exec('ROLLBACK');
      logger.error(`Rollback of migration ${migration.version} failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  const finalVersion = getCurrentSchemaVersion(db);
  logger.info(`Schema version after rollback: ${finalVersion}`);
}

/**
 * Rollback the last N migrations.
 */
export function rollbackLast(db: DatabaseSync, count: number = 1): void {
  const currentVersion = getCurrentSchemaVersion(db);
  const targetVersion = Math.max(0, currentVersion - count);
  rollbackMigrations(db, targetVersion);
}

export function resetSchemaVersion(db: DatabaseSync): void {
  db.exec('DROP TABLE IF EXISTS schema_version');
}