/**
 * Shared database row types for type-safe query results.
 */

export interface FunctionRow {
  id: number;
  file_id: number;
  name: string;
  signature: string | null;
  return_type: string | null;
  start_line: number | null;
  end_line: number | null;
  complexity: number | null;
  embedding: string | null;
}

export interface ClassRow {
  id: number;
  file_id: number;
  name: string;
  signature: string | null;
  start_line: number | null;
  end_line: number | null;
  methods_count: number | null;
  properties_count: number | null;
  embedding: string | null;
}

export interface ImportRow {
  id: number;
  file_id: number;
  source: string;
  kind: string | null;
  resolved: number;
  resolved_path: string | null;
}

export interface FileRow {
  id: number;
  project_id: number;
  path: string;
  relative_path: string;
  language: string | null;
  size_bytes: number | null;
  hash: string | null;
  embedding: string | null;
  last_scanned: string;
  agent_touched: number;
  agent_touched_by: string | null;
  agent_touched_at: string | null;
  cognitive_load: number;
}

export interface DebtItemRow {
  id: number;
  file_id: number | null;
  type: string;
  description: string | null;
  severity: string;
  suggestion: string | null;
  reasoning_trace: string | null;
  detected_at: string;
  resolved: number;
  resolved_at: string | null;
  relative_path?: string;
}

export interface CoherenceDecisionRow {
  id: number;
  file_id: number | null;
  code_hash: string;
  verdict: string;
  confidence: number | null;
  reasoning_trace: string | null;
  suggestions: string | null;
  analyzed_at: string;
  llm_provider: string | null;
  response_time_ms: number | null;
}

export interface ScanProfileRow {
  id: number;
  total_files: number;
  scanned_files: number;
  error_files: number;
  duration_ms: number;
  files_per_second: number;
  memory_used_mb: number;
  errors: string | null;
  created_at: string;
}

export interface ContractRow {
  id: number;
  name: string;
  description: string | null;
  source_pattern: string;
  forbidden_imports: string | null;
  required_patterns: string | null;
  severity: string;
  active: number;
  created_at: string;
}

export interface PatternRow {
  id: number;
  name: string;
  category: string;
  description: string | null;
  code_hash: string;
  confidence: number;
  first_seen: string;
  last_seen: string;
  usage_count: number;
  embedding: string | null;
}

export interface DynamicCallRow {
  id: number;
  from_function_id: number;
  to_function_id: number;
  dynamic: number;
  static_missed: number;
  call_count: number;
  workload_id: string;
  detected_at: string;
}

export interface AgentSessionRow {
  id: number;
  agent_name: string;
  started_at: string;
  ended_at: string | null;
  context_hash: string | null;
  decisions: string | null;
  fingerprint: string | null;
}

export interface AgentMemoryRow {
  id: number;
  session_id: number;
  scope: string;
  key: string;
  value: string;
  created_at: string;
  expires_at: string | null;
}
