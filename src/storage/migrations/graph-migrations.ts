import type { Migration } from './types.js';

export const graphMigrations: Migration[] = [
  {
    version: 105,
    name: 'autofix-feedback-reset-boundary',
    up: (db) => {
      const tableExists = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'autofix_feedback_resets'",
        )
        .get();
      if (!tableExists) return;
      const columns = db.prepare('PRAGMA table_info(autofix_feedback_resets)').all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === 'feedback_boundary')) {
        db.exec(
          'ALTER TABLE autofix_feedback_resets ADD COLUMN feedback_boundary INTEGER NOT NULL DEFAULT 0',
        );
      }
    },
    down: (db) => {
      // Keep the boundary column on rollback; removing it would make reset
      // semantics ambiguous for historical preference data.
      void db;
    },
  },
  {
    version: 104,
    name: 'autofix-feedback-policy-and-controls',
    up: (db) => {
      const tableExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'autofix_feedback'")
        .get();
      if (tableExists) {
        const columns = db.prepare('PRAGMA table_info(autofix_feedback)').all() as Array<{
          name: string;
        }>;
        if (!columns.some((column) => column.name === 'policy_version')) {
          db.exec(
            "ALTER TABLE autofix_feedback ADD COLUMN policy_version TEXT NOT NULL DEFAULT 'autofix-feedback-v1'",
          );
        }
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS autofix_feedback_preferences (
          project_id INTEGER NOT NULL,
          agent_key TEXT NOT NULL,
          opted_out INTEGER NOT NULL CHECK(opted_out IN (0, 1)),
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(project_id, agent_key)
        );
        CREATE TABLE IF NOT EXISTS autofix_feedback_resets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          agent_key TEXT NOT NULL,
          reset_at TIMESTAMP NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_autofix_feedback_resets_scope
          ON autofix_feedback_resets(project_id, agent_key, id);
        CREATE TRIGGER IF NOT EXISTS autofix_feedback_resets_no_update
          BEFORE UPDATE ON autofix_feedback_resets
          BEGIN
            SELECT RAISE(ABORT, 'autofix_feedback_resets is append-only');
          END;
        CREATE TRIGGER IF NOT EXISTS autofix_feedback_resets_no_delete
          BEFORE DELETE ON autofix_feedback_resets
          BEGIN
            SELECT RAISE(ABORT, 'autofix_feedback_resets is append-only');
          END;
      `);
    },
    down: (db) => {
      // Historical feedback and reset tombstones remain auditable on rollback.
      void db;
    },
  },
  {
    version: 103,
    name: 'agent-replay-events',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS replay_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          session_id INTEGER,
          event_type TEXT NOT NULL CHECK(event_type IN ('scan', 'context', 'review', 'edit', 'decision')),
          tool_name TEXT NOT NULL,
          file_path TEXT,
          source_hash TEXT CHECK(source_hash IS NULL OR length(source_hash) = 64),
          graph_hash TEXT CHECK(graph_hash IS NULL OR length(graph_hash) = 64),
          policy_version TEXT,
          tool_version TEXT,
          outcome TEXT NOT NULL DEFAULT '{}',
          event_hash TEXT NOT NULL UNIQUE CHECK(length(event_hash) = 64),
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_replay_events_project_file
          ON replay_events(project_id, file_path, id);
        CREATE INDEX IF NOT EXISTS idx_replay_events_project_session
          ON replay_events(project_id, session_id, id);
        CREATE TRIGGER IF NOT EXISTS replay_events_no_update
          BEFORE UPDATE ON replay_events
          BEGIN
            SELECT RAISE(ABORT, 'replay_events is append-only');
          END;
        CREATE TRIGGER IF NOT EXISTS replay_events_no_delete
          BEFORE DELETE ON replay_events
          BEGIN
            SELECT RAISE(ABORT, 'replay_events is append-only');
          END;
      `);
    },
    down: (db) => {
      // Replay evidence is intentionally retained during rollback.
      void db;
    },
  },
  {
    version: 102,
    name: 'evidence-ledger',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS evidence_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          event_type TEXT NOT NULL CHECK(event_type IN ('mcp-invocation', 'scan', 'context', 'review', 'edit', 'custom')),
          tool_name TEXT NOT NULL,
          input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
          graph_hash TEXT CHECK(graph_hash IS NULL OR length(graph_hash) = 64),
          policy_version TEXT NOT NULL,
          tool_version TEXT NOT NULL,
          scope TEXT,
          source_freshness TEXT NOT NULL,
          result_hash TEXT NOT NULL CHECK(length(result_hash) = 64),
          summary TEXT NOT NULL DEFAULT '{}',
          previous_hash TEXT,
          record_hash TEXT NOT NULL UNIQUE CHECK(length(record_hash) = 64),
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_evidence_ledger_project_id
          ON evidence_ledger(project_id, id);
        CREATE TRIGGER IF NOT EXISTS evidence_ledger_no_update
          BEFORE UPDATE ON evidence_ledger
          BEGIN
            SELECT RAISE(ABORT, 'evidence_ledger is append-only');
          END;
        CREATE TRIGGER IF NOT EXISTS evidence_ledger_no_delete
          BEFORE DELETE ON evidence_ledger
          BEGIN
            SELECT RAISE(ABORT, 'evidence_ledger is append-only');
          END;
      `);
    },
    down: (db) => {
      // The ledger is intentionally append-only. Rollback leaves the audit
      // table and its records intact rather than destroying evidence.
      void db;
    },
  },
  {
    version: 101,
    name: 'project-scope-agent-and-scan-state',
    up: (db) => {
      const addColumn = (table: string, column: string, sql: string): void => {
        const exists = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table);
        if (!exists) return;
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (!columns.some((entry) => entry.name === column)) db.exec(sql);
      };

      addColumn(
        'agent_sessions',
        'project_id',
        'ALTER TABLE agent_sessions ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1',
      );
      addColumn(
        'scan_profiles',
        'project_id',
        'ALTER TABLE scan_profiles ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1',
      );
      if (
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_sessions'")
          .get()
      ) {
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_sessions_project ON agent_sessions(project_id, started_at);',
        );
      }
      if (
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scan_profiles'")
          .get()
      ) {
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_scan_profiles_project ON scan_profiles(project_id, created_at);',
        );
      }
    },
    down: (db) => {
      // SQLite table rewrites are intentionally avoided for live databases;
      // retaining nullable-compatible scope columns is safer than risking
      // loss of agent history during rollback.
      db.exec(
        'DROP INDEX IF EXISTS idx_sessions_project; DROP INDEX IF EXISTS idx_scan_profiles_project;',
      );
    },
  },
  {
    // 99 is already used by the debt migration. Migration versions are
    // global, so this repair must be a new monotonic version; otherwise a
    // fresh database records debt v99 and silently skips this table creation.
    version: 106,
    name: 'project-worktree-index-identities',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_worktrees (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          repository_root TEXT NOT NULL,
          common_git_dir TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          branch TEXT NOT NULL,
          head_sha TEXT NOT NULL,
          namespace_key TEXT NOT NULL UNIQUE,
          last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(project_id, worktree_path, head_sha),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_project_worktrees_project
          ON project_worktrees(project_id, last_seen_at);
        CREATE INDEX IF NOT EXISTS idx_project_worktrees_repository
          ON project_worktrees(repository_root, worktree_path);
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS project_worktrees;');
    },
  },
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
    version: 107,
    name: 'scan-profile-skipped-file-observability',
    up: (db) => {
      const tableExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scan_profiles'")
        .get();
      if (!tableExists) return;
      const columns = db.prepare('PRAGMA table_info(scan_profiles)').all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === 'skipped_files')) {
        db.exec('ALTER TABLE scan_profiles ADD COLUMN skipped_files INTEGER NOT NULL DEFAULT 0');
      }
      if (!columns.some((column) => column.name === 'skipped_paths')) {
        db.exec('ALTER TABLE scan_profiles ADD COLUMN skipped_paths TEXT');
      }
    },
    down: (db) => {
      // SQLite versions used by Node do not guarantee DROP COLUMN support;
      // retain additive observability columns during rollback.
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
  {
    version: 109,
    name: 'taint-resource-kinds',
    up: (db) => {
      const resourceTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'resources'")
        .get();
      const dataFlowTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'data_flows'")
        .get();
      if (!resourceTable || !dataFlowTable) return;

      // SQLite CHECK constraints are immutable. Rebuild the two graph tables
      // together so existing resource/data-flow ids and all project data are
      // retained while adding explicit PROCESS and CODE resource kinds.
      db.exec(`
        DROP INDEX IF EXISTS idx_resources_qualified;
        DROP INDEX IF EXISTS idx_resources_project_qualified;
        DROP INDEX IF EXISTS idx_data_flows_from;
        DROP INDEX IF EXISTS idx_data_flows_to;
        DROP INDEX IF EXISTS idx_data_flows_kind;
        DROP INDEX IF EXISTS idx_data_flows_project;
        DROP INDEX IF EXISTS idx_data_flows_languages;

        ALTER TABLE data_flows RENAME TO data_flows_legacy_109;
        ALTER TABLE resources RENAME TO resources_legacy_109;

        CREATE TABLE resources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          qualified_name TEXT UNIQUE NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('FILE', 'NETWORK', 'DATABASE', 'ENV', 'STDIN', 'STDOUT', 'STDERR', 'SOCKET', 'PROCESS', 'CODE')),
          identity TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          project_id INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO resources (id, qualified_name, kind, identity, created_at, project_id)
          SELECT id, qualified_name, kind, identity, created_at, COALESCE(project_id, 1)
          FROM resources_legacy_109;

        CREATE TABLE data_flows (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_resource_id INTEGER NOT NULL,
          to_resource_id INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('resource', 'arg', 'return')),
          via TEXT,
          source_function_id INTEGER,
          target_function_id INTEGER,
          source_language TEXT,
          target_language TEXT,
          detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          project_id INTEGER NOT NULL DEFAULT 1,
          FOREIGN KEY (from_resource_id) REFERENCES resources(id) ON DELETE CASCADE,
          FOREIGN KEY (to_resource_id) REFERENCES resources(id) ON DELETE CASCADE,
          FOREIGN KEY (source_function_id) REFERENCES functions(id) ON DELETE SET NULL,
          FOREIGN KEY (target_function_id) REFERENCES functions(id) ON DELETE SET NULL
        );
        INSERT INTO data_flows
          (id, from_resource_id, to_resource_id, kind, via, source_function_id,
           target_function_id, source_language, target_language, detected_at, project_id)
          SELECT id, from_resource_id, to_resource_id, kind, via, source_function_id,
                 target_function_id, source_language, target_language, detected_at,
                 COALESCE(project_id, 1)
          FROM data_flows_legacy_109;

        DROP TABLE data_flows_legacy_109;
        DROP TABLE resources_legacy_109;
        CREATE INDEX idx_resources_qualified ON resources(qualified_name);
        CREATE INDEX idx_resources_project_qualified ON resources(project_id, qualified_name);
        CREATE INDEX idx_data_flows_from ON data_flows(from_resource_id);
        CREATE INDEX idx_data_flows_to ON data_flows(to_resource_id);
        CREATE INDEX idx_data_flows_kind ON data_flows(kind);
        CREATE INDEX idx_data_flows_project ON data_flows(project_id);
        CREATE INDEX idx_data_flows_languages ON data_flows(source_language, target_language);
      `);
    },
    down: (db) => {
      // Keeping the expanded CHECK constraint on rollback avoids losing valid
      // PROCESS/CODE evidence that may have been recorded after migration.
      void db;
    },
  },
  {
    version: 110,
    name: 'project-scoped-pattern-identity',
    up: (db) => {
      const patternsExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'patterns'")
        .get();
      if (!patternsExists) return;

      const patternColumns = db.prepare('PRAGMA table_info(patterns)').all() as Array<{
        name: string;
      }>;
      const patternColumnNames = new Set(patternColumns.map((column) => column.name));
      // Some pre-v95 fixture databases only had the four original columns.
      // Add nullable/defaulted metadata before the table rebuild so the
      // migration remains backwards-compatible with those databases too.
      if (!patternColumnNames.has('description'))
        db.exec('ALTER TABLE patterns ADD COLUMN description TEXT');
      if (!patternColumnNames.has('confidence'))
        db.exec('ALTER TABLE patterns ADD COLUMN confidence REAL DEFAULT 0.5');
      // SQLite does not allow non-constant defaults in ALTER TABLE. These
      // legacy columns are nullable here; the INSERT below supplies the
      // current timestamp for rows that did not have them.
      if (!patternColumnNames.has('first_seen'))
        db.exec('ALTER TABLE patterns ADD COLUMN first_seen TIMESTAMP');
      if (!patternColumnNames.has('last_seen'))
        db.exec('ALTER TABLE patterns ADD COLUMN last_seen TIMESTAMP');
      if (!patternColumnNames.has('usage_count'))
        db.exec('ALTER TABLE patterns ADD COLUMN usage_count INTEGER DEFAULT 1');
      if (!patternColumnNames.has('embedding'))
        db.exec('ALTER TABLE patterns ADD COLUMN embedding TEXT');
      const hasProjectId = patternColumnNames.has('project_id');
      const violationsExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pattern_violations'")
        .get();

      // The original UNIQUE(code_hash, name) made a pattern discovered in one
      // project collide with the same pattern in every other project. Rebuild
      // the parent and its FK child so the identity is truly project-local.
      db.exec(`
        DROP INDEX IF EXISTS idx_patterns_category;
        DROP INDEX IF EXISTS idx_patterns_confidence;
        DROP INDEX IF EXISTS idx_patterns_name_hash;
        DROP INDEX IF EXISTS idx_patterns_project;
        ${violationsExists ? 'ALTER TABLE pattern_violations RENAME TO pattern_violations_legacy_110;' : ''}
        ALTER TABLE patterns RENAME TO patterns_legacy_110;

        CREATE TABLE patterns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          description TEXT,
          code_hash TEXT NOT NULL,
          confidence REAL DEFAULT 0.5,
          first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          usage_count INTEGER DEFAULT 1,
          embedding TEXT,
          project_id INTEGER NOT NULL DEFAULT 1,
          UNIQUE(code_hash, name, project_id)
        );
        INSERT INTO patterns
          (id, name, category, description, code_hash, confidence, first_seen,
           last_seen, usage_count, embedding, project_id)
          SELECT id, name, category, description, code_hash, COALESCE(confidence, 0.5),
                 COALESCE(first_seen, CURRENT_TIMESTAMP),
                 COALESCE(last_seen, CURRENT_TIMESTAMP), COALESCE(usage_count, 1), embedding,
                 ${hasProjectId ? 'COALESCE(project_id, 1)' : '1'}
          FROM patterns_legacy_110;
        CREATE INDEX idx_patterns_category ON patterns(category);
        CREATE INDEX idx_patterns_confidence ON patterns(confidence);
        CREATE INDEX idx_patterns_name_hash ON patterns(name, code_hash);
        CREATE INDEX idx_patterns_project ON patterns(project_id);
        ${
          violationsExists
            ? `
        CREATE TABLE pattern_violations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pattern_id INTEGER NOT NULL,
          file_id INTEGER NOT NULL,
          line_number INTEGER,
          severity TEXT CHECK(severity IN ('high', 'medium', 'low')),
          detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          resolved BOOLEAN DEFAULT 0,
          FOREIGN KEY (pattern_id) REFERENCES patterns(id) ON DELETE CASCADE,
          FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
        );
        INSERT INTO pattern_violations
          (id, pattern_id, file_id, line_number, severity, detected_at, resolved)
          SELECT id, pattern_id, file_id, line_number, severity, detected_at, resolved
          FROM pattern_violations_legacy_110;
        DROP TABLE pattern_violations_legacy_110;
        `
            : ''
        }
        DROP TABLE patterns_legacy_110;
      `);
    },
    down: (db) => {
      // Keep the project-scoped constraint on rollback. Reintroducing the
      // global uniqueness rule would make valid multi-project data lossy.
      void db;
    },
  },
];
