# MCP Tools

ProjectMind exposes a typed MCP surface for codebase intelligence. Start the
server with:

```bash
pm mcp
```

The default `PROJECTMIND_TOOLS=core` profile registers the dedicated tools
listed below. Set `PROJECTMIND_TOOLS=all` to add the generated `pm_*` CLI
parity tools. `run_cli` remains available in both profiles.

## Context, reports, and project lifecycle

- `check_coherence` — Check code against learned project patterns.
- `get_context` — Assemble imports, dependents, structure, and similar files.
- `store_memory` / `get_memory` — Persist and retrieve agent memory.
- `debt_report` — Report cognitive debt by severity.
- `scale_report` — Report project size, languages, coverage, and hotspots.
- `genome_score` — Compute the project coherence score.
- `scan_project` — Build or refresh the knowledge graph. When a non-simple
  embedding provider is configured, the scan initializes it and writes
  file/function/class vectors with the same provider and configured dimension
  as later queries. Optional-provider fallback is reported rather than hidden.
- `start_session` / `end_session` / `get_agent_sessions` — Manage agent sessions.
- `resource_subscribe` / `resource_unsubscribe` — Manage session resource-update subscriptions.

## Evidence and reproducibility

- `prove_claim` — Check a claim against explicitly supplied source files. A
  fresh source hash is reported as source-backed evidence only; semantic, AST,
  typecheck, and runtime verification remain separate claims.
- `verify_freshness` — Compare current source hashes with the indexed graph and
  return per-file freshness states plus actionable next steps.
- `kg_query` with `action: "feature-map"` — Map conservative path-derived
  feature candidates and cross-feature import flows. Labels are evidence for
  structure, not proof of business semantics.

For reproducible CI review, use the CLI `pm graph snapshot` / `pm graph verify`
pair and export `pm pr-preview --format sarif`. Snapshots are content-addressed
and portable; verification detects graph drift but does not claim runtime
correctness.

## Imports, graph, and paths

- `trace_imports` — Trace transitive imports for a file.
- `find_circular_deps` — Find dependency cycles.
- `resolve_import` — Resolve an import in the knowledge graph.
- `get_dependents` — Find reverse dependencies.
- `get_dependency_graph` — Get a module dependency graph.
- `kg_query` — Run graph algorithms (stats, PageRank, communities, paths, BFS, and path-derived feature/flow mapping).
- `kg_stats` — Get node, edge, and PageRank statistics.
- `export_architecture_diagram` — Export SVG, PNG, or Mermaid architecture data.
- `resolve_path` — Resolve TypeScript/JavaScript paths and aliases.
- `find_file_by_import` — Find files matching an import pattern.

## Architecture, contracts, and synchronization

- `check_architecture` — Check architectural rules and markers.
- `analyze_impact` — Analyze a file change and its dependents.
- `suggest_refactor` — Recommend refactors by complexity, duplication, architecture, or performance.
- `check_contracts` — Enforce project architectural contracts.
- `auto_fix` — Preview or apply AST-safe mechanical fixes; preview is the default.
- `register_file_watch` / `unregister_file_watch` — Manage session-scoped file watches.
- `get_file_status` — Get live coherence and dependency status for a file.
- `sync_context` — Synchronize decisions, patterns, issues, and working state.

## Coordination and predictive analysis

- `agent_locks` — Advisory per-file locks for concurrent agents.
- `predict_merge_risk` — Estimate collision risk before multi-agent edits.
- `predict_impact_risk` — Predict change impact with risk levels.
- `predict_impact` — Predict affected tests and callers from a change.
- `broadcast_intent` / `check_intent_conflicts` — Share and inspect planned edits.
- `suggest_next_files` — Rank files to read next for a task.
- `find_patterns` — Find learned patterns by interface shape.

## Search, symbols, and code analysis

- `search_intent` — Hybrid natural-language task search. Each result includes
  `semanticEvidence`: `measured` for an observed vector similarity,
  `rank-derived` when only graph ordering was available, and
  `structural-heuristic` for import/dependent expansion. This prevents a
  heuristic rank from being presented as a measured semantic score.
- `semantic_search` — Embedding-based file or symbol search. Use
  `scope: "file"` for whole-file retrieval or `scope: "symbol"` for indexed
  functions/classes with source locations. Every response includes the active
  provider, query/index dimensions, source hash/scan metadata, index coverage,
  the persisted provider/model manifest, and explicit limitations. The query
  re-reads every indexed source path and reports freshness counts; stale,
  missing, unindexed, or unknown paths downgrade evidence to `partial`. A
  missing or incompatible manifest also downgrades evidence to `partial`.
- `structural_search` — AST search with optional dry-run replacement.
- `find_symbol_references` — Find symbol references through the TypeScript language service.
- `find_symbol_definition` — Find a symbol definition through the TypeScript language service.
- `analyze_taint` / `record_taint` — Analyze or persist taint flows.
- `record_data_flow` / `get_data_flows` / `get_resource_flows` — Manage data-flow edges.
- `clear_data_flows` — Clear current-project data-flow edges; protected by MCP safety guards.

## Projects, memory, embeddings, and security

- `list_projects` / `create_project` / `switch_project` — Manage graph projects.
- `store_team_memory` / `get_team_memories` / `search_team_memories` — Share durable team knowledge.
- `init_embedding_provider` — Select and initialize `simple`, `openai`,
  `transformers`, `unixcoder`, or `codebert`. Optional providers report an
  explicit fallback and limitations when credentials, model files, or runtime
  dependencies are unavailable. Repeating the call is idempotent for the full
  provider/model/key/path configuration; changing that configuration causes a
  deliberate reinitialization.
- `generate_embedding` — Generate a vector for text or code.
- `get_embedding_provider` — Inspect embedding configuration.
- `ingest_trace` — Persist runtime call-trace data.
- `recommend_skills` — Recommend skills for a task from project evidence.
- `scan_cves` — Run the dependency vulnerability audit; `fix` is preview-only.

## CLI bridge

`run_cli` exposes the approved CLI commands that do not need a dedicated typed
tool. It accepts an argument array only, pins the working directory to
`PROJECTMIND_ROOT`, blocks shell execution and destructive commands, and keeps
path-valued outputs inside the project root.

All dedicated registrations expose an input schema, a callable handler, and the
four explicit MCP behavior annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`). Generated parity tools use the same
contract.

Example:

```json
{
  "name": "run_cli",
  "arguments": { "args": ["health", "--json"] }
}
```

All tool names are unprefixed in Claude Code, Cursor, Windsurf, and similar
clients. OpenCode prefixes them with the server name, for example
`projectmind_get_context` and `projectmind_run_cli`.
