import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.js';

/**
 * Migrations 94-95: Debt change frequency, project ID backfill, and FK cascades.
 */
export const debtMigrations: Migration[] = [
  {
    version: 94,
    name: 'debt_change_frequency_and_project_id_backfill',
    up: (db: DatabaseSync) => {
      // 1. Rebuild debt_items to expand the type CHECK constraint from 7 types
      //    to 8 (adding 'change_frequency'). Same pattern as migration 7.
      const debtExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'debt_items'")
        .get();
      if (debtExists) {
        const debtDdl = db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'debt_items'")
          .get() as { sql: string } | undefined;
        if (!debtDdl?.sql.includes('change_frequency')) {
          db.exec(`
            CREATE TABLE IF NOT EXISTS debt_items_migrated (
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
            INSERT INTO debt_items_migrated (id, file_id, type, description, severity, suggestion, reasoning_trace, detected_at, resolved, resolved_at)
              SELECT id, file_id, type, description, severity, suggestion, reasoning_trace, detected_at, resolved, resolved_at FROM debt_items;
            DROP TABLE debt_items;
            ALTER TABLE debt_items_migrated RENAME TO debt_items;
          `);
        }
        db.exec('CREATE INDEX IF NOT EXISTS idx_debt_resolved ON debt_items(resolved);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_debt_items_type ON debt_items(type, severity);');
      }

      // 2. Idempotently add project_id to files (same pattern as migration 3).
      const filesExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'")
        .get();
      if (filesExists) {
        const filesColumns = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
        const hasProjectId = filesColumns.some(c => c.name === 'project_id');
        if (!hasProjectId) {
          db.exec('ALTER TABLE files ADD COLUMN project_id INTEGER DEFAULT 1');
          db.exec('UPDATE files SET project_id = 1 WHERE project_id IS NULL');
        }
        db.exec('CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);');
      }

      // 3. Idempotently add project_id to data_flows (same pattern as migration 3).
      const dataFlowsExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'data_flows'")
        .get();
      if (dataFlowsExists) {
        const dataFlowsColumns = db.prepare("PRAGMA table_info(data_flows)").all() as Array<{ name: string }>;
        const hasProjectIdDataFlows = dataFlowsColumns.some(c => c.name === 'project_id');
        if (!hasProjectIdDataFlows) {
          db.exec('ALTER TABLE data_flows ADD COLUMN project_id INTEGER DEFAULT 1');
          db.exec('UPDATE data_flows SET project_id = 1 WHERE project_id IS NULL');
        }
        db.exec('CREATE INDEX IF NOT EXISTS idx_data_flows_project ON data_flows(project_id);');
      }
    },
    down: (db: DatabaseSync) => {
      // Rebuild debt_items back to the 7-type constraint.
      const debtExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'debt_items'")
        .get();
      if (!debtExists) return;
      db.exec(`
        CREATE TABLE IF NOT EXISTS debt_items_old (
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
        INSERT INTO debt_items_old (id, file_id, type, description, severity, suggestion, reasoning_trace, detected_at, resolved, resolved_at)
          SELECT id, file_id, type, description, severity, suggestion, reasoning_trace, detected_at, resolved, resolved_at FROM debt_items WHERE type IN ('pattern_drift', 'architectural_drift', 'redundancy', 'agent_conflict', 'complexity', 'code_age', 'cognitive_load');
        DROP TABLE debt_items;
        ALTER TABLE debt_items_old RENAME TO debt_items;
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_debt_resolved ON debt_items(resolved);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_debt_items_type ON debt_items(type, severity);');
      // Note: project_id columns are not removed (SQLite limitation, cf. migration 3)
    },
  },
  {
    version: 95,
    name: 'fk_cascades_and_imports_index',
    up: (db: DatabaseSync) => {
      // Rebuild three tables so their FKs to files/patterns carry
      // ON DELETE CASCADE (child rows are meaningless once the parent file
      // or pattern is gone).

      // 1. pattern_violations: both FKs cascade.
      const violationsExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pattern_violations'")
        .get();
      if (violationsExists) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS pattern_violations_migrated (
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
          INSERT INTO pattern_violations_migrated (id, pattern_id, file_id, line_number, severity, detected_at, resolved)
            SELECT id, pattern_id, file_id, line_number, severity, detected_at, resolved FROM pattern_violations;
          DROP TABLE pattern_violations;
          ALTER TABLE pattern_violations_migrated RENAME TO pattern_violations;
        `);
      }

      // 2. coherence_decisions: file_id cascades.
      const decisionsExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coherence_decisions'")
        .get();
      if (decisionsExists) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS coherence_decisions_migrated (
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
            FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
          );
          INSERT INTO coherence_decisions_migrated (id, file_id, code_hash, verdict, confidence, reasoning_trace, suggestions, analyzed_at, llm_provider, response_time_ms)
            SELECT id, file_id, code_hash, verdict, confidence, reasoning_trace, suggestions, analyzed_at, llm_provider, response_time_ms FROM coherence_decisions;
          DROP TABLE coherence_decisions;
          ALTER TABLE coherence_decisions_migrated RENAME TO coherence_decisions;
        `);
        db.exec('CREATE INDEX IF NOT EXISTS idx_coherence_hash ON coherence_decisions(code_hash);');
      }

      // 3. debt_items: file_id cascades; preserve the 8-type CHECK from migration 94.
      const debtExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'debt_items'")
        .get();
      if (debtExists) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS debt_items_migrated (
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
            FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
          );
          INSERT INTO debt_items_migrated (id, file_id, type, description, severity, suggestion, reasoning_trace, detected_at, resolved, resolved_at)
            SELECT id, file_id, type, description, severity, suggestion, reasoning_trace, detected_at, resolved, resolved_at FROM debt_items;
          DROP TABLE debt_items;
          ALTER TABLE debt_items_migrated RENAME TO debt_items;
        `);
        db.exec('CREATE INDEX IF NOT EXISTS idx_debt_resolved ON debt_items(resolved);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_debt_items_type ON debt_items(type, severity);');
      }

      // 4. Serve imports.ts resolved-path lookups and graph traversal.
      const importsExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='imports'").get();
      if (importsExists) {
        db.exec('CREATE INDEX IF NOT EXISTS idx_imports_resolved_path ON imports(resolved_path);');
      }
    },
    down: (db: DatabaseSync) => {
      // Best-effort revert: drop the index and rebuild the three tables with
      // plain (non-cascading) FKs, mirroring migrations 7/94 down style.
      db.exec('DROP INDEX IF EXISTS idx_imports_resolved_path;');

      const violationsExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pattern_violations'")
        .get();
      if (violationsExists) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS pattern_violations_old (
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
          INSERT INTO pattern_violations_old (id, pattern_id, file_id, line_number, severity, detected_at, resolved)
            SELECT id, pattern_id, file_id, line_number, severity, detected_at, resolved FROM pattern_violations;
          DROP TABLE pattern_violations;
          ALTER TABLE pattern_violations_old RENAME TO pattern_violations;
        `);
      }

      const decisionsExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coherence_decisions'")
        .get();
      if (decisionsExists) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS coherence_decisions_old (
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
          INSERT INTO coherence_decisions_old (id, file_id, code_hash, verdict, confidence, reasoning_trace, suggestions, analyzed_at, llm_provider, response_time_ms)
            SELECT id, file_id, code_hash, verdict, confidence, reasoning_trace, suggestions, analyzed_at, llm_provider, response_time_ms FROM coherence_decisions;
          DROP TABLE coherence_decisions;
          ALTER TABLE coherence_decisions_old RENAME TO coherence_decisions;
        `);
        db.exec('CREATE INDEX IF NOT EXISTS idx_coherence_hash ON coherence_decisions(code_hash);');
      }

      const debtExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'debt_items'")
        .get();
      if (debtExists) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS debt_items_old (
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
          INSERT INTO debt_items_old (id, file_id, type, description, severity, suggestion, reasoning_trace, detected_at, resolved, resolved_at)
            SELECT id, file_id, type, description, severity, suggestion, reasoning_trace, detected_at, resolved, resolved_at FROM debt_items;
          DROP TABLE debt_items;
          ALTER TABLE debt_items_old RENAME TO debt_items;
        `);
        db.exec('CREATE INDEX IF NOT EXISTS idx_debt_resolved ON debt_items(resolved);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_debt_items_type ON debt_items(type, severity);');
      }
    },
  },
];
