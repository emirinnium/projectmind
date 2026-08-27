-- Migration 090: Add predictive impact analysis tables and columns
ALTER TABLE projects ADD COLUMN last_impact_scan TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS test_failure_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_id TEXT NOT NULL,
  file_path TEXT,
  module_name TEXT,
  failure_occurred BOOLEAN DEFAULT 0,
  severity TEXT CHECK(severity IN ('low', 'medium', 'high')) DEFAULT 'medium',
  logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_test_failure_pred ON test_failure_log(prediction_id);
