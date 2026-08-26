# Changelog

All notable changes to this project will be documented in this format.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-08-26

From analysis to action: agents get progress feedback during long operations,
real graph algorithms over the knowledge graph, live file watching, task-aware
context ranking, code that actually changes (auto-fix), multi-agent file
coordination with merge-risk prediction, a local web dashboard, and semantic
team-memory search — plus a critical data-integrity migration.

### Added
- **MCP progress notifications** (`notifications/progress`): throttled stage
  updates for `scan_project` and `debt_report resolveAfter`; clients that
  pass `_meta.progressToken` see "import analysis 250/1000" style messages.
- **`kg_query` MCP tool**: real graph algorithms — `pagerank` (critical
  files), `communities`, N-hop `subgraph`, shortest import `path`,
  `impact` (with direct test files via new tested-by edges), `bfs`, `stats`.
- **`pm watch`**: recursive fs.watch daemon; debounced single-file re-parse +
  knowledge-graph upsert + coherence-cache invalidation per touched file.
- **Smart Context**: optional `task` parameter on `get_context` adds a ranked
  `smartContext` section (direct dependents, blast radius, tests, semantic
  neighbors, task keywords) with per-item reasons and token-budget capping.
- **Auto-Fix Engine** (`pm refactor autofix <file> [--apply]`): five
  AST-based fixers — organize-imports, dedupe-imports, remove-unused-imports,
  add-return-types (checker-inferred, safe-primitive whitelist, honest skips),
  var-to-const (provably never reassigned). Diff preview by default.
- **Multi-agent coordination**: `agent_file_locks` table (TTL-expiring) and
  the `agent_locks` MCP tool (`acquire`/`release`/`list`/`check`) so parallel
  agents stop colliding silently.
- **Merge-conflict prediction**: `agent_locks check` now returns a `risk`
  verdict (low/medium/high) computed from blast-radius closure overlap and
  shared-dependency direction between competing edit sets.
- **AST clone detection** (`pm dedup --mode ast`): Type-2 fingerprinting
  (rename-tolerant function-level clones) across indexed files.
- **`pm serve`**: zero-dependency local web dashboard — live metrics cards,
  PageRank list, SVG graph mini-map on http://127.0.0.1:7788.
- **Semantic team-memory search**: `pm memory search "<query>"` and the
  `search_team_memories` MCP tool — cosine-ranked RAG v1 over team memories,
  offline-capable, auto-upgrades with stronger embedding providers.

### Changed
- `scan_project` uses full scan profiles (real duration/files-per-second/
  memory stats persisted) and honors its previously-dead `full` parameter.
- Tool annotations completed: human-readable `title` fallback,
  `destructiveHint: false` + `openWorldHint: false` for read-only tools
  (LLM/network tools keep conservative defaults).
- Resource/prompt registration retries once with detailed error reporting.
- Graceful shutdown ends exactly the session this server process opened
  (no more multi-instance session leaks).
- Deterministic auto-fixer execution order; type analysis reads pre-fix lines.

### Fixed
- **Critical (migration v6)**: `store_team_memory` upsert never worked on
  databases created before the `UNIQUE(scope, key)` constraint existed —
  every call failed with "ON CONFLICT clause does not match". Automatic
  rebuild-with-dedup migration applied on startup.
- Knowledge-graph direction bugs: `extractSubgraph` now expands BOTH
  directions (dependents were invisible before — 1 node became 69 on real
  data); `getImpactRadius` traverses reverse dependencies instead of
  counting the file's own imports; SQL double-negative typo cleaned.
- Statement cache no longer hands out statements prepared against a closed/
  previous database after re-initialization (per-instance WeakMap LRU).
- HTTP mode: optional `PROJECTMIND_HTTP_TOKEN` auth (timing-safe compare)
  and per-IP sliding-window rate limiting (`PROJECTMIND_HTTP_RATE_LIMIT`,
  default 120/min, 429 + Retry-After).

### Security
- Loopback-bound HTTP endpoint warns loudly when unauthenticated and rejects
  oversized payloads as before; tokens compared in constant time.

## [0.6.0] - 2026-08-25

Agent workflow enforcement and editor-native intelligence: ProjectMind stops
being documentation agents should read and becomes a gate they cannot skip,
while the knowledge graph surfaces directly inside the editor.

### Added
- **`pm autopilot pre-commit`**: enforced quality gate with real exit codes —
  high-severity debt must be zero, architectural cycles zero, genome score at
  or above threshold (`--min-genome`, default 70%). `--format json` for CI.
- **`pm autopilot install-hooks [--uninstall]`**: installs a marked git
  `pre-commit` hook running the gate — agents AND humans cannot skip it;
  refuses to touch foreign hooks on uninstall.
- **VSCode CodeLens**: file-level `🧠 N dependents · load X · ✍️ agent-touched`
  lens plus cycle warnings and one-click **Show Impact**
  (analyze_impact incl. impacted test count).
- **VSCode Hover**: the same knowledge-graph context rendered over any line;
  60-second per-file cache keeps typing smooth.
- **Extension ↔ Resources/Prompts bridge**: MCP client gains
  resources/list·read and prompts/list·get — the editor can now consume
  `pm://schema|config|stats` and the workflow prompts the server exposes.
- **Living Context Window (v1)**: `sync_context` pull automatically enriches
  responses with the reported current file's dependency closure and similar
  files from embeddings.
- **Predictive refactoring signal**: refactor-roi compares 30-day vs 90-day
  churn windows and flags candidates whose churn is *accelerating* before
  they become hotspots.

### Fixed
- VSCode language-service Range construction for secondary CodeLens.

## [0.5.0] - 2026-08-25

Three-sprint quality & capability release driven by external audits:
real metrics replace every remaining placeholder, the MCP surface gains
spec-alignment hardening, and agents get temporal/symbol intelligence.

### Added
- **`git-insights <file>`**: temporal context from git — author distribution,
  rename/refactor history (`log --follow`), recent commit subjects.
- **`refs <file> <symbol>`**: find-all-references via the TypeScript language
  service (type-aware, alias-tolerant position picking).
- **`workspace`**: pnpm/npm/yarn workspace discovery, internal package
  dependency edges with semver range sanity checks, Nx/Turborepo detection.
- **Test impact analysis**: `analyze_impact` (MCP) `tests` flag and
  `impact --tests` (CLI) list tests/specs inside the reverse-dependency closure.
- **Token budgeting**: `get_context` accepts `maxTokens` and trims list
  sections to a soft budget (~chars/4 heuristic).
- **MCP resources** (`pm://schema`, `pm://config` secrets-masked, `pm://stats`)
  and workflow prompts (`impact-first-refactor`, `pre-commit-checklist`,
  `debt-triage`, `explain-file-context`).
- **Stateless Streamable HTTP transport**: set `PROJECTMIND_HTTP_PORT` to serve
  `POST /mcp` (JSON responses) for remote/team deployments.
- **Tool surface profiles**: `PROJECTMIND_TOOLS=core` skips generated parity
  tools (~45 vs ~134 tools) for clients with small active-tool budgets.
- **PR intelligence export**: `pr-preview --format github` emits GH-flavored
  comment markdown ready for `gh pr comment --body-file`.
- **Coverage trend**: `test-quality` persists snapshots and reports delta vs
  the previous run with regression warnings.

### Changed
- **Agent fingerprints are real**: computed from the actual content of
  agent-touched files (async preference, assertion density, error-handling
  style, naming convention); `-1/'unknown'` sentinels when unmeasurable.
- **skill-recommend analyzes the codebase**: maps real scanned files onto
  skills via path signals and drops skills with no evidence in the repo.
- **Feature-flag staleness works**: lastModified from git history with mtime
  fallback.
- **Coupling abstractness** is computed from source (interfaces + abstract
  classes over all type artifacts) instead of a hardcoded zero.
- **docgen** extracts exports/JSDoc through the TypeScript compiler AST.
- **Embeddings storage**: files table writes compact Float32 BLOBs (~45%
  smaller than JSON text); dual-format reader converts legacy rows on rescan.
- **Hot file refresh**: watched-file change events incrementally re-parse and
  upsert into the knowledge graph without a full scan.
- **sync_context pull** ranks memories by current-file relevance + recency;
  **suggest_refactor duplication** includes persisted cross-file redundancy
  findings.

### Fixed
- `flags countReferences` crashed at runtime under ESM (`require()` call).
- SBOM `escapeXml` was a no-op (entities stripped) — XML injection/corruption
  risk eliminated; UUID generation now RFC4122 v4 via node:crypto.
- Generated contract tests import the engine from the installed package
  instead of unresolvable path aliases.

### Security
- Single enforcement guard across the MCP surface: destructive operations
  (`project delete`, `debt clear*`, `data-flow clear`, `trace clear`,
  `doctor rebuild-index`) blocked via `run_cli` bridge AND generated parity
  tools.
- Tool annotations: read-only dedicated tools carry `readOnlyHint` +
  `idempotentHint`; read-only CLI-root parity tools annotated automatically —
  compliant clients stop prompting for pure queries.
- `init-mcp`: new `claude-desktop` profile (per-OS global config), Windsurf
  moved to the official `~/.codeium/windsurf/mcp_config.json`, explicit
  `type: "stdio"` entries.
- SDK floor raised to `^1.30.0` (tracking the 2026-07-28 spec line).

## [0.4.0] - 2026-08-23

Full agent integration release: MCP parity generator, CLI bridge tool,
workflow instruction files for all major coding agents, and the last
fabricated/simulated metrics eliminated.

### Added
- **CLI-parity generator**: walks commander tree and auto-registers one
  typed `pm_<cmd>[_<sub>]` MCP tool per executable CLI action (92 tools).
  Parity is automatic — new commands appear as tools on next server start.
- **`run_cli` bridge tool**: exposes the full CLI surface to agents for
  capabilities without a dedicated tool (shell disabled, argv array only,
  cwd pinned, timeout override, recursive mcp blocked)
- **`init-mcp <agent>` command**: generates correct MCP config file for
  claude-code, cursor, opencode, windsurf, or vscode with merge support
- **Agent workflow instruction files**: `AGENTS.md`, `.cursorrules`,
  `.windsurfrules`, `.claude/instructions.md` — every major coding agent
  now uses ProjectMind tools proactively without being asked
- **`.mcp.json`** at repo root for zero-config Claude Code integration
- `docs/MCP.md`: per-client setup guide + full tool catalog + workflow

### Fixed
- structural-search `-m async` modifier never matched (friendly-name
  alias map added: AsyncKeyword, ExportKeyword, etc.)
- ownership `--since` option now actually filters by date
- dedup: removed threshold/min-lines options never consumed upstream
- adr index: missing `--dir` option caused crash in sandbox environments
- mcp-server main-module detection hardened (argv[1] undefined-safe)
- registry.registerAllTools made async to properly await parity generation

### Changed
- cli.ts refactored: shared buildProgram() in src/cli/program.ts (single
  source of truth for CLI tree); parseAsync replaces sync parse
- exitOverride removed from root program (was intercepting successful
  process.exit(0) calls as errors, breaking exit codes)

### Security
- npm audit remains at 0 vulnerabilities

## [0.3.5] - 2026-08-23

Honesty-completion release: the last fabricated/simulated metrics and stub
commands are gone — every command now performs real analysis or states its
limits explicitly.

### Fixed
- `refactor-roi`: ROI churn input now comes from real git history (shared
  `collectGitChurn` util); random numbers removed
- `test-quality`: coverage read from `coverage/coverage-summary.json` when
  present (-1 = unmeasured, never invented); flaky metric replaced with a
  real static skipped/todo signal; mutation score honestly reports as
  unmeasured without a mutator (e.g. Stryker)
- `doctor fix-imports`: implemented for real — groups unresolved imports per
  file from the knowledge graph, suggests tsconfig alias targets, counts
  alias-fixable cases (analysis mode; no auto-editing)
- `health`: metrics wired to live data (import resolution rate, pattern
  count/high-confidence, agent sessions) instead of hardcoded zeros;
  import-resolution check degrades to warning below 80%
- `trace convert`: accepts an input file, validates/normalizes trace-event
  JSON arrays; other formats fail with an explicit not-implemented error
- `scale_report` (MCP): requesting a non-active root now returns explicit
  guidance instead of silently ignoring the parameter

### Changed
- `register_file_watch` (MCP): registers a REAL session-scoped fs.watch —
  change events flag the file as agent-touched; watchers close on unregister
- pr-preview comments aligned with the already-real git-diff implementation

## [0.3.1] - 2026-08-23

### Fixed
- **Windows CLI crash on installed package**: `cli.mjs` passed a raw
  `C:\...` path to dynamic `import()`, throwing
  `ERR_UNSUPPORTED_ESM_URL_SCHEME` for every `npx projectmind` / global-bin
  invocation on Windows (POSIX was unaffected; in-repo `node dist/cli.js`
  runs never hit it). Now converted via `pathToFileURL`.
- Verified end-to-end from the packed tarball in a clean directory:
  banner, `--version`, and a real `genome` run against an empty project.

## [0.3.0] - 2026-08-22

Stability release: every CLI command now performs real analysis (no simulated
metrics), the two hidden circular dependencies were broken, and all known
npm vulnerabilities are resolved.

### Fixed
- **storage**: `getDependents`/`getDirectDependents` match `resolved_path`
  (dependents & impact analysis now return real results); kg memory reads
  honour `expires_at`
- **debt**: pattern-drift and architectural-drift findings persist to
  `debt_items` (previously discarded); findings dedupe across scans;
  `project_genome` pruned to latest 10 snapshots; drift detection scoped to
  product code (`src/`)
- **parser**: shared types extracted to `parser/types.ts`, breaking the two
  real circular dependencies `ast-parser <-> ast/parser` and
  `ast-parser <-> multilang-parser`
- **config**: API keys resolve per selected provider (no cross-provider key
  leakage); embeddings OpenAI key gains env fallback
- **cli**: `pm init` writes `.projectmindrc.json` where `loadConfig` reads it;
  `pm mcp` wrapped in asyncHandler; health icons/encoding repaired
- **mcp**: server reports the real package version (was hardcoded 1.0.0);
  `get_context` structure fields fixed (were undefined via snake_case)
- **vscode**: extension performs the mandatory MCP initialize handshake
  (previously every command timed out); sidebar buttons wired to live data;
  inline diagnostics activated; phantom `find_similar` call replaced with
  `get_context includeSimilar`
- engines raised to `node >=22.13.0` (required by `node:sqlite`)
- CLI logo asset now ships in the published package

### Added
- Real data sources: churn from git log; contract tests via ContractEngine;
  dependency audit/outdated/licenses via npm; PR preview via three-dot git
  diff; ref-level API-surface diff via git ls-tree/show; module coupling via
  resolved import edges
- `ArchitecturalContract.excludePaths` for rule-definition exemptions
- Cache flush on process exit; embedding-cache invalidation on rescan

### Changed
- Unified content hashing (`utils/stableHash`) replacing five weak 32-bit
  hash copies; unified retry helpers
- Multilang parser adds C support (`.c`); scanner stops reporting unsupported
  `.php` files as errors

### Security
- Overrides: `adm-zip ^0.6.0`, `protobufjs ^8.7.2`, `sharp ^0.35.3`
- `npm audit`: 7 vulnerabilities (1 critical) → **0**

### Install note
Use `npm install --legacy-peer-deps` while tree-sitter grammars declare an
older optional peer (see README "Installation Notes").

### Added
- Initial public release preparation
- README.md with full documentation
- MIT License
- .gitignore for proper file exclusion
- GitHub Actions CI workflow (multi-Node matrix)
- NPM publish configuration with `files` field
- `.projectmindrc.example.json` template

### Changed
- Updated `package.json` with repository, bugs, homepage, publishConfig
- Added `prepare` script for automatic build on publish

## [0.1.0] - 2026-08-18

### Added
- **Core Architecture**
  - Coherence Engine (fast pattern matching + LLM deep analysis)
  - Debt Tracker (genome score, redundancy, architectural drift, pattern drift)
  - Scale Manager (project scale, modules, hotspots, coverage heatmaps)
  - Knowledge Graph (SQLite-backed, files, functions, classes, imports, embeddings)
  - Pattern Library (extraction, coherence scoring, violation detection)
  - Multi-language AST Parser (TypeScript, JavaScript)
  - Code Embeddings (128-dimensional, cosine similarity)

- **CLI (16 commands)**
  - `init`, `scan`, `check`, `report`, `context`, `session`, `memory`
  - `scale`, `debt`, `genome`, `resolve`, `mcp`, `health`, `debug`, `doctor`, `agent`

- **MCP Server (38 tools)**
  - Core: coherence, context, memory, scan, genome, debt, scale, sessions
  - Import/Dependency: trace, circular deps, resolve, dependents, graph, path resolution
  - Architecture: check, impact analysis, refactor suggestions
  - Continuous Sync: file watch, status, context sync

- **LLM Providers**
  - Anthropic (Claude 3.5 Sonnet, Opus)
  - OpenAI (GPT-4o, GPT-4)
  - Ollama (local models)

- **Agent Memory Bridge**
  - Cross-session persistent memory
  - Session management with decisions & fingerprints
  - Agent coverage tracking

- **Testing**
  - Integration test suite (48 tests passing)
  - Database, KG, coherence, debt, scale, embeddings, patterns, sessions, memory

### Technical Details
- TypeScript strict mode, ESM modules
- Node.js ≥ 22 required
- SQLite via `better-sqlite3` (native bindings)
- Zero-runtime-dependency core (only 4 production deps)

---

## Release Notes Template

### [x.y.z] - YYYY-MM-DD

#### Added
- New features

#### Changed
- Changes in existing functionality

#### Deprecated
- Soon-to-be removed features

#### Removed
- Removed features

#### Fixed
- Bug fixes

#### Security
- Vulnerability fixes