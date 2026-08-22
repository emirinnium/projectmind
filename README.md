# ProjectMind

Living Codebase Intelligence Layer for AI Agents.

ProjectMind scans your codebase, builds a knowledge graph, and exposes it through a CLI and an MCP server so agents can reason about architecture, debt, dependencies, embeddings, taint, and runtime traces.

## Quick Start

```bash
npm install
npm run build
projectmind scan
projectmind health
```

## CLI Commands

### Core
- `projectmind init` — Initialize ProjectMind in the current project
- `projectmind scan [-r <root>]` — Scan project and build/update the knowledge graph
- `projectmind check [<path>]` — Check coherence of files
- `projectmind report` — Generate full coherence + debt report
- `projectmind context <file>` — Get relevant context for a file
- `projectmind mcp` — Start ProjectMind as an MCP server (stdio mode)

### Intelligence
- `projectmind search <query>` — Search code by pattern
- `projectmind impact <file>` — Analyze change impact using dependency data
- `projectmind debt-prioritize` — Show debt items sorted by severity and frequency
- `projectmind genome` — Compute and display project coherence genome

### Architecture
- `projectmind graph` — Show module dependency graph (Mermaid format)
- `projectmind layers` — Enforce architectural layer boundaries
- `projectmind coupling` — Analyze module coupling metrics
- `projectmind api-surface` — Track public API surface changes
- `projectmind dedup` — Find duplicate code using redundancy detection
- `projectmind churn` — Analyze code churn and risk hotspots

### Security & Quality
- `projectmind audit` — Security audit: secrets, crypto patterns, OWASP checks
- `projectmind license` — License compliance (basic check)
- `projectmind sbom` — Generate Software Bill of Materials
- `projectmind flags` — Audit feature flags: usage, staleness, coverage, cleanup
- `projectmind secrets-life` — Secrets lifecycle management
- `projectmind test-quality` — Analyze test effectiveness
- `projectmind contract-test` — Generate tests for architectural contracts

### Refactoring & Docs
- `projectmind refactor` — Code refactoring helpers
- `projectmind refactor-roi` — Calculate refactoring ROI
- `projectmind testgen [<file>]` — Generate test scaffolding for source files
- `projectmind docgen` — Generate documentation from code
- `projectmind migrate` — Migration helpers for common upgrades

### Agent & Memory
- `projectmind session` — Manage agent sessions
- `projectmind memory [<scope> [<key>]]` — Read or write agent memory
- `projectmind skill-recommend` — Recommend skill improvements for agents
- `projectmind context-budget [<task>]` — Optimize context window usage
- `projectmind onboard` — Generate personalized onboarding path
- `projectmind agent` — Manage and inspect agent sessions and coverage

### Advanced Intelligence
- `projectmind trace` — Runtime call tracing: ingest test traces and dynamic call data
  - `trace ingest <file>` — Ingest a trace JSON file
  - `trace convert` — Convert another trace format into ProjectMind trace JSON
  - `trace show` — Show dynamic call trace data
  - `trace clear` — Clear dynamic call trace data
- `projectmind project` — Multi-project management
  - `project list` — List all projects
  - `project create <name> <rootPath>` — Create a new project
  - `project switch <id>` — Switch to a different project
  - `project current` — Show the current project
  - `project delete <id>` — Delete a project and all its files
- `projectmind data-flow` — Data-flow and taint analysis
  - `data-flow record` — Record a data-flow edge between resources
  - `data-flow list` — List all data flows for the current project
  - `data-flow resource <qualifiedName>` — Show all flows for a specific resource
  - `data-flow clear` — Clear all data flows for the current project
- `projectmind structural-search` — AST-based structural search/replace
  - `structural-search search` — Search for AST nodes matching a pattern
  - `structural-search replace` — Replace AST nodes matching a pattern
- `projectmind embed` — Embedding generation and code similarity search
  - `embed init` — Initialize the embedding provider
  - `embed generate` — Generate embedding for a text or code snippet
  - `embed similar` — Find similar code snippets in the codebase
  - `embed provider` — Show the current embedding provider

### Diagnostics
- `projectmind health` — Check ProjectMind system health
- `projectmind debug` — Debug and diagnostic commands
- `projectmind doctor` — Automated fixes and health remediation
- `projectmind heatmap` — Show coverage heatmap
- `projectmind ownership` — Show agent file ownership from session data
- `projectmind pr-preview` — Preview PR impact
- `projectmind deps-fresh` — Monitor dependency freshness
- `projectmind adr` — Architecture Decision Records management

## MCP Tools

ProjectMind can run as an MCP server (`projectmind mcp`). The server exposes tools organized by domain:

### Core Tools
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

### Import / Dependency Tools
- `trace_imports` — Trace all transitive imports for a file
- `find_circular_deps` — Find all circular dependencies in the project
- `resolve_import` — Resolve an import path to the actual file
- `get_dependents` — Find all files that import/depend on a given file
- `get_dependency_graph` — Get the dependency graph for a module/directory

### Path Tools
- `resolve_path` — Resolve a file path with TypeScript/JS module resolution rules
- `find_file_by_import` — Find all files that match an import pattern

### Architecture Tools
- `check_architecture` — Check if a file complies with project architectural patterns
- `analyze_impact` — Analyze the impact of changing a file
- `suggest_refactor` — Get refactoring suggestions based on code patterns

### Sync / Watch Tools
- `file_watch` — Register interest in a file for continuous synchronization
- `get_file_status` — Get real-time status of a file
- `sync_context` — Synchronize context between coding agent and ProjectMind
- `unregister_file_watch` — Stop watching a file for continuous synchronization

### Dynamic Tracing Tools
- `ingest_trace` — Ingest runtime call trace data into the knowledge graph

### Structural Search / Replace Tools
- `structural_search` — Find code by AST pattern
- `structural_replace` — Rewrite code by AST pattern

### Project Management Tools
- `list_projects` — List all projects in the knowledge graph
- `create_project` — Create a new project
- `switch_project` — Switch the current project context

### Data-Flow / Taint Tools
- `record_data_flow` — Record a data-flow edge between resources or functions
- `get_data_flows` — Get all recorded data flows for the current project
- `get_resource_flows` — Get all data flows for a specific resource
- `clear_data_flows` — Clear all recorded data flows for the current project

### Embedding Tools
- `init_embedding_provider` — Initialize the embedding provider
- `generate_embedding` — Generate an embedding vector for text or code
- `get_embedding_provider` — Get the current embedding provider

## Database

ProjectMind uses SQLite for persistence. The default database path is `.projectmind/pm-knowledge.db`.

Schema migrations are versioned and run automatically on startup:
- v1: initial schema
- v2: dynamic tracing (`calls` table)
- v3: multi-project graph + data-flow (`projects`, `resources`, `data_flows` tables)
- v4: settings table
- v5: team memories table

### Migration Rollback

Migrations support down operations for rollback:

```typescript
import { rollbackMigrations, rollbackLast } from './src/storage/migrations.js';

// Rollback to a specific version
rollbackMigrations(db, 3);

// Rollback the last N migrations
rollbackLast(db, 1);
```

## Architecture

- `src/storage` — SQLite schema, migrations, knowledge graph, queries
- `src/core` — Coherence engine, debt tracker, scale manager, LLM providers
- `src/parser` — AST parsing, pattern extraction, embeddings, taint analysis, structural search
- `src/mcp` — MCP server and tool registrations
- `src/cli` — Commander-based CLI commands and shared utilities
- `src/tracer` — Runtime trace utilities
- `src/types` — Shared TypeScript types and declarations
- `src/utils` — Configuration and shared utilities

## Development

```bash
npm run build          # TypeScript compile + tsc-alias
npm run lint           # ESLint check
npm run lint:fix       # ESLint auto-fix
npm run format         # Prettier format
npm run format:check   # Prettier check
npm run typecheck      # TypeScript type checking
npm test               # Integration tests
npm run test:vitest    # Unit tests
npm run test:coverage  # Unit tests with coverage report
npm run test:watch     # Watch mode for unit tests
npm run start:mcp      # Start MCP server
npm run ci             # Full CI pipeline (lint + typecheck + test + coverage)
```

## Repository Pattern

ProjectMind uses a repository pattern for data access with full dependency injection support:

```typescript
// Using default singleton database
const fileRepo = new FileRepository();

// Using custom database (for testing)
const db = new DatabaseSync(':memory:');
const manager = new DatabaseManager();
manager.init();
const fileRepo = new FileRepository(manager.getDb());
```

### Available Repositories
- `ProjectRepository` — Project CRUD operations
- `FileRepository` — File tracking and metadata
- `ImportRepository` — Import/dependency analysis
- `MemoryRepository` — Agent sessions and memory
- `DataFlowRepository` — Taint analysis data flows
- `DynamicCallRepository` — Runtime call tracing

## Installation Notes (Dependency Overrides & Peer Deps)

This project pins security overrides and tolerates a known tree-sitter peer
conflict. Install with:

```bash
npm install --legacy-peer-deps
```

**Why:** the tree-sitter grammar packages (`tree-sitter-java`, etc.) still
declare `peerOptional tree-sitter@^0.21.1` while this project uses
`tree-sitter@^0.25.1`. Plain `npm install` / `npm audit fix` therefore fails
with ERESOLVE until grammars publish updated peers.

**Security overrides** (see `package.json > overrides`) keep transitive CVEs
at zero without breaking downgrades:

| Override | Reason |
|---|---|
| `adm-zip@^0.6.0` | GHSA-xcpc-8h2w-3j85 (4GB ZIP allocation) via onnxruntime-node |
| `protobufjs@^8.7.2` | Critical code-injection set via onnx-proto / transformers |
| `sharp@^0.35.3` | libvips CVEs via @xenova/transformers |

All three were verified compatible: `onnxruntime-node` and
`@xenova/transformers` load correctly on protobufjs 8 + sharp 0.35.

## License

MIT
