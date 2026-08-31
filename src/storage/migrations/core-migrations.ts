import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.js';

/**
 * Migrations 1-11: Initial schema, calls, projects, settings, team memories,
 * OAuth persistence, and circular dependencies.
 */
export const coreMigrations: Migration[] = [
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
      const filesColumns = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
      const hasLastSynced = filesColumns.some(c => c.name === 'last_synced');
      if (!hasLastSynced) {
        db.exec('ALTER TABLE files ADD COLUMN last_synced TIMESTAMP');
      }

      // 2. Rebuild debt_items table to expand the type CHECK constraint
      //    from 4 types to 7 (adding 'complexity', 'code_age', 'cognitive_load').
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
      // at issuance and never written.
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
];
