import type { Migration } from './types.js';

export const reviewMigrations: Migration[] = [
  {
    version: 96,
    name: 'review-history-and-finding-lifecycle',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS review_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          base_ref TEXT NOT NULL,
          head_ref TEXT NOT NULL,
          changed_files INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_review_runs_project ON review_runs(project_id, created_at);
        CREATE TABLE IF NOT EXISTS review_findings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL,
          project_id INTEGER NOT NULL,
          fingerprint TEXT NOT NULL,
          rule TEXT NOT NULL,
          severity TEXT NOT NULL,
          file TEXT NOT NULL,
          line INTEGER NOT NULL,
          message TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          resolved_at TIMESTAMP,
          UNIQUE(project_id, fingerprint),
          FOREIGN KEY(run_id) REFERENCES review_runs(id)
        );
        CREATE INDEX IF NOT EXISTS idx_review_findings_status ON review_findings(project_id, status);
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS review_findings; DROP TABLE IF EXISTS review_runs;');
    },
  },
];
