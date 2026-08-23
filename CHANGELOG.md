# Changelog

All notable changes to this project will be documented in this format.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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