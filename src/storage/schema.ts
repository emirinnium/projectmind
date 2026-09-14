export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  root_path TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_scanned TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_impact_scan TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS team_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  base_value TEXT,
  is_public BOOLEAN DEFAULT 1,
  project_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, scope, key)
);

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

CREATE INDEX IF NOT EXISTS idx_team_memories_scope ON team_memories(scope);
CREATE INDEX IF NOT EXISTS idx_team_memories_agent ON team_memories(agent_name);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  language TEXT,
  size_bytes INTEGER,
  hash TEXT,
  embedding TEXT,
  last_scanned TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  agent_touched BOOLEAN DEFAULT 0,
  agent_touched_by TEXT,
  agent_touched_at TIMESTAMP,
  cognitive_load REAL DEFAULT 0,
  last_synced TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  project_id INTEGER NOT NULL DEFAULT 1,
  UNIQUE(project_id, path)
);

CREATE TABLE IF NOT EXISTS functions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  signature TEXT,
  return_type TEXT,
  start_line INTEGER,
  end_line INTEGER,
  complexity INTEGER,
  embedding TEXT,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  signature TEXT,
  start_line INTEGER,
  end_line INTEGER,
  methods_count INTEGER,
  properties_count INTEGER,
  embedding TEXT,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

-- Persistent source coordinates. The source hash makes every byte/symbol
-- range content-addressed, so callers can reject a stale index instead of
-- returning a coordinate from an older version of the file.
CREATE TABLE IF NOT EXISTS source_ranges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL DEFAULT 1,
  source_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('file', 'function', 'class', 'method', 'property', 'import', 'export')),
  name TEXT NOT NULL,
  parent_name TEXT,
  symbol_path TEXT NOT NULL,
  start_byte INTEGER NOT NULL CHECK(start_byte >= 0),
  end_byte INTEGER NOT NULL CHECK(end_byte >= start_byte),
  start_line INTEGER NOT NULL CHECK(start_line >= 1),
  end_line INTEGER NOT NULL CHECK(end_line >= start_line),
  start_column INTEGER NOT NULL CHECK(start_column >= 1),
  end_column INTEGER NOT NULL CHECK(end_column >= 1),
  UNIQUE(file_id, source_hash, kind, name, start_byte, end_byte),
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_source_ranges_file_hash
  ON source_ranges(file_id, source_hash);
CREATE INDEX IF NOT EXISTS idx_source_ranges_project_symbol
  ON source_ranges(project_id, symbol_path, kind);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  named TEXT NOT NULL DEFAULT '[]',
  kind TEXT,
  resolved BOOLEAN DEFAULT 0,
  resolved_path TEXT,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

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

CREATE TABLE IF NOT EXISTS circular_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_path TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved BOOLEAN DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_circular_deps_cycle_path ON circular_dependencies(cycle_path);

CREATE TABLE IF NOT EXISTS patterns (
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

CREATE TABLE IF NOT EXISTS pattern_violations (
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

CREATE TABLE IF NOT EXISTS agent_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  project_id INTEGER NOT NULL DEFAULT 1,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP,
  context_hash TEXT,
  decisions TEXT,
  fingerprint TEXT
);

CREATE TABLE IF NOT EXISTS agent_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL DEFAULT '{}',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_profiles_name ON agent_profiles(agent_name);

CREATE TABLE IF NOT EXISTS coherence_decisions (
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

CREATE TABLE IF NOT EXISTS debt_items (
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
  project_id INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reasoning_traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id INTEGER NOT NULL,
  step_number INTEGER,
  step_text TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (decision_id) REFERENCES coherence_decisions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_genome (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checksum TEXT UNIQUE,
  genome_data TEXT NOT NULL,
  coherence_score REAL,
  computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  source_pattern TEXT NOT NULL,
  forbidden_imports TEXT,
  required_patterns TEXT,
  severity TEXT CHECK(severity IN ('high', 'medium', 'low')) DEFAULT 'medium',
  active BOOLEAN DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scan_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL DEFAULT 1,
  total_files INTEGER NOT NULL,
  scanned_files INTEGER NOT NULL,
  error_files INTEGER NOT NULL,
  skipped_files INTEGER NOT NULL DEFAULT 0,
  skipped_paths TEXT,
  duration_ms INTEGER NOT NULL,
  files_per_second INTEGER NOT NULL,
  memory_used_mb REAL NOT NULL,
  errors TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  qualified_name TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('FILE', 'NETWORK', 'DATABASE', 'ENV', 'STDIN', 'STDOUT', 'STDERR', 'SOCKET', 'PROCESS', 'CODE')),
  identity TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  project_id INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS data_flows (
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

CREATE INDEX IF NOT EXISTS idx_resources_qualified ON resources(qualified_name);
CREATE INDEX IF NOT EXISTS idx_data_flows_from ON data_flows(from_resource_id);
CREATE INDEX IF NOT EXISTS idx_data_flows_to ON data_flows(to_resource_id);
CREATE INDEX IF NOT EXISTS idx_data_flows_kind ON data_flows(kind);
CREATE INDEX IF NOT EXISTS idx_data_flows_project ON data_flows(project_id);
CREATE INDEX IF NOT EXISTS idx_data_flows_languages ON data_flows(source_language, target_language);

-- Multi-agent coordination: advisory file locks (soft, TTL-expiring).
CREATE TABLE IF NOT EXISTS agent_file_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  reason TEXT,
  acquired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  UNIQUE(file_path)
);

CREATE INDEX IF NOT EXISTS idx_agent_file_locks_path ON agent_file_locks(file_path);

-- Collaborative agent intent tracking (live broadcast + conflict prediction)
-- F20: broadcast_at / expires_at are INTEGER unix milliseconds (canonical).
-- F17: expected_changes holds JSON describing planned signature/type changes.
CREATE TABLE IF NOT EXISTS pending_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  intent_type TEXT NOT NULL CHECK(intent_type IN ('read','write','refactor','delete')),
  target_files TEXT NOT NULL,
  session_id TEXT,
  description TEXT,
  expected_changes TEXT,
  broadcast_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  expires_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 300000)
);

CREATE INDEX IF NOT EXISTS idx_pending_intents_agent ON pending_intents(agent_id);
CREATE INDEX IF NOT EXISTS idx_pending_intents_type ON pending_intents(intent_type);

CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
CREATE INDEX IF NOT EXISTS idx_files_touched ON files(agent_touched);
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
CREATE INDEX IF NOT EXISTS idx_files_relative_path ON files(relative_path);
CREATE INDEX IF NOT EXISTS idx_functions_file ON functions(file_id);
CREATE INDEX IF NOT EXISTS idx_classes_file ON classes(file_id);
CREATE INDEX IF NOT EXISTS idx_patterns_category ON patterns(category);
CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON patterns(confidence);
CREATE INDEX IF NOT EXISTS idx_patterns_name_hash ON patterns(name, code_hash);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON agent_sessions(agent_name, started_at);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON agent_memory(scope);
CREATE INDEX IF NOT EXISTS idx_memory_expires ON agent_memory(expires_at);
CREATE INDEX IF NOT EXISTS idx_debt_resolved ON debt_items(resolved);
CREATE INDEX IF NOT EXISTS idx_coherence_hash ON coherence_decisions(code_hash);
CREATE INDEX IF NOT EXISTS idx_genome_checksum ON project_genome(checksum);

-- Additional performance indexes (moved after table creation)
-- Note: Indexes for columns added by migrations (project_id, etc.) are created in migrations
CREATE INDEX IF NOT EXISTS idx_functions_name ON functions(name);
CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source);
CREATE INDEX IF NOT EXISTS idx_imports_resolved_path ON imports(resolved_path);
CREATE INDEX IF NOT EXISTS idx_calls_workload_dynamic ON calls(workload_id, dynamic);
CREATE INDEX IF NOT EXISTS idx_agent_memory_session ON agent_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory(scope, key);

-- Hash-chained, payload-free audit trail for evidence-backed decisions.
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

-- Repo-scoped accept/reject signals for explainable Auto-Fix recommendations.
CREATE TABLE IF NOT EXISTS autofix_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  agent_name TEXT,
  fixer TEXT NOT NULL,
  feedback TEXT NOT NULL CHECK(feedback IN ('accepted', 'rejected', 'skipped')),
  source_hash TEXT CHECK(source_hash IS NULL OR length(source_hash) = 64),
  policy_version TEXT NOT NULL DEFAULT 'autofix-feedback-v1',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_autofix_feedback_project_fixer
  ON autofix_feedback(project_id, fixer, agent_name, id);
CREATE TRIGGER IF NOT EXISTS autofix_feedback_no_update
  BEFORE UPDATE ON autofix_feedback
  BEGIN
    SELECT RAISE(ABORT, 'autofix_feedback is append-only');
  END;
CREATE TRIGGER IF NOT EXISTS autofix_feedback_no_delete
  BEFORE DELETE ON autofix_feedback
  BEGIN
    SELECT RAISE(ABORT, 'autofix_feedback is append-only');
  END;
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
  feedback_boundary INTEGER NOT NULL DEFAULT 0,
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
-- idx_coherence_decisions_hash removed: duplicated idx_coherence_hash (line above)
CREATE INDEX IF NOT EXISTS idx_debt_items_type ON debt_items(type, severity);

-- Privacy-preserving search preference observations. Query text and source
-- contents are never stored; only a stable query digest, repository-relative
-- result path, and bounded numeric ranking features are retained.
CREATE TABLE IF NOT EXISTS search_interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  agent_key TEXT NOT NULL,
  query_hash TEXT NOT NULL CHECK(length(query_hash) = 64),
  result_path TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 1 AND position <= 1000),
  feedback TEXT NOT NULL CHECK(feedback IN ('selected', 'opened', 'included', 'skipped')),
  features TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_search_interactions_project_query
  ON search_interactions(project_id, query_hash, id);
CREATE INDEX IF NOT EXISTS idx_search_interactions_agent
  ON search_interactions(project_id, agent_key, id);

-- Payload-free session learning events. The value is an identifier or a
-- bounded scalar supplied by the caller, never source text.
CREATE TABLE IF NOT EXISTS agent_session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  agent_key TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('file_touched', 'tool_used', 'pattern', 'outcome')),
  event_key TEXT NOT NULL,
  event_value TEXT,
  success INTEGER CHECK(success IS NULL OR success IN (0, 1)),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_session_events_project
  ON agent_session_events(project_id, agent_key, event_type, id);
CREATE INDEX IF NOT EXISTS idx_agent_session_events_session
  ON agent_session_events(session_id, id);
`;
