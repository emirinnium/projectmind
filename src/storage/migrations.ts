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