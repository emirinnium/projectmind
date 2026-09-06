import type { Migration } from './types.js';

export const graphMigrations: Migration[] = [
  {
    version: 98,
    name: 'project-scoped-identities',
    up: (db) => {
      // Existing graph tables have live foreign-key dependents. Do not rebuild
      // them in-place: add missing scope columns idempotently and keep the
      // legacy global uniqueness as a compatibility constraint until a
      // dedicated online table-rewrite migration can update every dependent FK.
      const addColumn = (table: string, column: string, sql: string): void => {
        const exists = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table);
        if (!exists) return;
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (!columns.some((entry) => entry.name === column)) db.exec(sql);
      };
      addColumn(
        'resources',
        'project_id',
        'ALTER TABLE resources ADD COLUMN project_id INTEGER DEFAULT 1',
      );
      addColumn(
        'team_memories',
        'project_id',
        'ALTER TABLE team_memories ADD COLUMN project_id INTEGER DEFAULT 1',
      );
      if (
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'resources'").get()
      ) {
        db.exec('UPDATE resources SET project_id = 1 WHERE project_id IS NULL;');
      }
      if (
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'team_memories'")
          .get()
      ) {
        db.exec('UPDATE team_memories SET project_id = 1 WHERE project_id IS NULL;');
      }
      const teamSql = String(
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_memories'")
          .get()?.sql ?? '',
      );
      if (teamSql.includes('UNIQUE(scope, key)')) {
        db.exec(`
          CREATE TABLE team_memories_project_scoped (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_name TEXT NOT NULL,
            scope TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            base_value TEXT,
            is_public BOOLEAN DEFAULT 1,
            project_id INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(project_id, scope, key)
          );
          INSERT OR REPLACE INTO team_memories_project_scoped
            (id, agent_name, scope, key, value, base_value, is_public, project_id, created_at, updated_at)
            SELECT id, agent_name, scope, key, value, base_value, is_public,
                   COALESCE(project_id, 1), created_at, updated_at
            FROM team_memories;
          DROP TABLE team_memories;
          ALTER TABLE team_memories_project_scoped RENAME TO team_memories;
        `);
      }
      if (
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'resources'").get()
      ) {
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_resources_project_qualified ON resources(project_id, qualified_name);',
        );
      }
      if (
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'team_memories'")
          .get()
      ) {
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_team_memories_project_scope_key ON team_memories(project_id, scope, key);',
        );
      }
    },
    down: (db) => {
      // Scope columns/indexes are intentionally retained on rollback because
      // removing them would reintroduce cross-project filtering gaps.
      void db;
    },
  },
  {
    version: 97,
    name: 'cross-language-data-flow-metadata',
    up: (db) => {
      const tableExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'data_flows'")
        .get();
      if (!tableExists) return;
      const columns = db.prepare('PRAGMA table_info(data_flows)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'source_language')) {
        db.exec('ALTER TABLE data_flows ADD COLUMN source_language TEXT');
      }
      if (!columns.some((column) => column.name === 'target_language')) {
        db.exec('ALTER TABLE data_flows ADD COLUMN target_language TEXT');
      }
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_data_flows_languages ON data_flows(source_language, target_language);',
      );
    },
    down: (db) => {
      // SQLite versions used by Node do not guarantee DROP COLUMN support;
      // leaving nullable metadata is safer than rebuilding a live graph table.
      db.exec('DROP INDEX IF EXISTS idx_data_flows_languages;');
    },
  },
];
