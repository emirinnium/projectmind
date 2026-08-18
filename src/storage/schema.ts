export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  relative_path TEXT NOT NULL,
  language TEXT,
  size_bytes INTEGER,
  hash TEXT,
  embedding TEXT,
  last_scanned TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  agent_touched BOOLEAN DEFAULT 0,
  agent_touched_by TEXT,
  agent_touched_at TIMESTAMP,
  cognitive_load REAL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  kind TEXT,
  resolved BOOLEAN DEFAULT 0,
  resolved_path TEXT,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS circular_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_path TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved BOOLEAN DEFAULT 0
);

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
  UNIQUE(code_hash, name)
);

CREATE TABLE IF NOT EXISTS pattern_violations (
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

CREATE TABLE IF NOT EXISTS agent_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
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
  FOREIGN KEY (file_id) REFERENCES files(id)
);

CREATE TABLE IF NOT EXISTS debt_items (
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

CREATE TABLE IF NOT EXISTS scan_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  total_files INTEGER NOT NULL,
  scanned_files INTEGER NOT NULL,
  error_files INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  files_per_second INTEGER NOT NULL,
  memory_used_mb REAL NOT NULL,
  errors TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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
`;
