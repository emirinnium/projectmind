# MCP Tools

ProjectMind exposes its capabilities through the Model Context Protocol (MCP). Start the server with:

```bash
projectmind mcp
```

## Tool Reference

### Core
- `check_coherence` — Check code coherence against project patterns
- `get_context` — Get relevant context for a file
- `store_memory` — Store agent memory
- `get_memory` — Retrieve agent memory
- `debt_report` — Generate cognitive debt report
- `scale_report` — Get project scale and coverage report
- `genome_score` — Compute project coherence genome score
- `scan_project` — Scan project and build/update knowledge graph
- `start_session` — Start a new agent session
- `end_session` — End an agent session
- `get_agent_sessions` — Get agent sessions

### Import / Dependency
- `trace_imports` — Trace all transitive imports for a file
- `find_circular_deps` — Find all circular dependencies in the project
- `resolve_import` — Resolve an import path to the actual file
- `get_dependents` — Find all files that import/depend on a given file
- `get_dependency_graph` — Get the dependency graph for a module/directory

### Path Resolution
- `resolve_path` — Resolve a file path with TypeScript/JS module resolution rules
- `find_file_by_import` — Find all files that match an import pattern

### Architecture / Impact
- `check_architecture` — Check if a file complies with project architectural patterns
- `analyze_impact` — Analyze the impact of changing a file
- `suggest_refactor` — Get refactoring suggestions based on code patterns

### Continuous Sync
- `file_watch` — Register interest in a file for continuous synchronization
- `get_file_status` — Get real-time status of a file
- `sync_context` — Synchronize context between coding agent and ProjectMind
- `unregister_file_watch` — Stop watching a file for continuous synchronization

### Dynamic Tracing
- `ingest_trace` — Ingest runtime call trace data into the knowledge graph

### Structural Search / Replace
- `structural_search` — Find code by AST pattern
- `structural_replace` — Rewrite code by AST pattern

### Project Management
- `list_projects` — List all projects in the knowledge graph
- `create_project` — Create a new project
- `switch_project` — Switch the current project context

### Data-Flow / Taint Analysis
- `record_data_flow` — Record a data-flow edge between resources or functions
- `get_data_flows` — Get all recorded data flows for the current project
- `get_resource_flows` — Get all data flows for a specific resource
- `clear_data_flows` — Clear all recorded data flows for the current project

### Embeddings
- `init_embedding_provider` — Initialize the embedding provider
- `generate_embedding` — Generate an embedding vector for text or code
- `get_embedding_provider` — Get the current embedding provider

### Intelligence & Agent Coordination
- `search_intent` — Semantic + structural search with a natural-language task query
- `predict_impact` — Predict which tests/callers break when a file changes
- `plan_context_budget` — Rank which files to load within a token budget
- `broadcast_intent` — Announce planned edits so other agents avoid conflicts
- `check_intent_conflicts` — Check whether other agents hold overlapping write intents
- `agent_locks` — Advisory per-file locks for multi-agent coordination
- `predict_merge_risk` — Predict merge collisions before multi-agent edits
- `find_patterns` — Find previously learned design patterns by interface shape

### Search & Analysis
- `semantic_search` — Rank files purely by embedding similarity to a query
- `structural_search` / `structural_replace` — AST-pattern find and rewrite
- `kg_query` — Graph algorithms over the knowledge graph (PageRank, communities, paths)
- `find_symbol_references` — Every reference of a symbol via the real TypeScript language service
- `suggest_next_files` — Task-aware "what to read next" ranking over the knowledge graph

### Skills
- `recommend_skills{task, limit?}` — Given a free-text task description, rank the skill
  catalog (label/description/whyItHelps/importance) by task-token overlap, repo evidence
  (via the scale report) and importance. Returns `{ name, description, score, reason }`
  per skill plus the CLI commands to apply each. Deterministic, no LLM required.
