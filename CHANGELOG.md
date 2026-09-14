# Changelog

All notable changes to this project will be documented in this format.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.5] - 2026-09-14

- **Cross-platform CI reliability:** temporary fixtures now use absolute OS temp
  roots, the path-security regression test sends a real NUL byte, and coverage
  builds `dist` before importing standalone benchmark scripts. Release and CI
  workflows use Node 24-compatible action runtimes.
- **MCP install reliability:** the generated `npx` handshake invocation now
  separates package arguments from ProjectMind arguments, so `--profile` is
  forwarded correctly on Windows and POSIX clients.
- **Analysis follow-up hardening:** reduced repeated graph/index work, added
  bounded async source preparation, fixed structural-search glob filtering,
  and kept all selected source paths behind the central security contract.
- **Automation output:** `pm debt --json` now emits a stable machine-readable
  debt report; the generated temporary database test fixture is isolated under
  the OS temp directory and no longer leaves files in the repository.
- **Repository hygiene:** removed the unused broken `.github/action/action.yml`
  entry that referenced a nonexistent `dist/action.js`; added the tested,
  bounded cross-platform action at `.github/actions/projectmind/action.yml`.
- **Incremental scan correctness:** changed files now refresh bounded reverse
  dependents so persisted function/call edges do not remain stale; scan
  profiles expose the dependency refresh count and depth. Root-level Git files
  are included in churn signals.
- **Agent intelligence:** added privacy-preserving search feedback/reranking,
  project/agent-scoped session insights, predictive bug-surface ranking, and
  evidence-first `pm ask` / `ask_codebase` with explicit refusal and freshness
  limits.
- **Smart context:** `suggest_next_files` can now produce a token-budgeted
  context plan and ROI comparison. Full-file baselines retain zero-relevance
  candidates; unavailable range/canonical/closure plans remain explicit.
- **OpenRouter reasoning controls:** schema-validated `llm.reasoning` options
  are forwarded only when explicitly configured; reasoning-only and
  length-truncated responses remain separate from final content.
- **Taint project-scope correctness:** `exploit_path` project mode now fails
  closed for unindexed entries and follows only the requested entry's forward
  resolved static ES-import closure, excluding unrelated indexed files. Windows
  path identity comparisons are case-insensitive and separator-safe.
- **Context ROI accounting:** heuristic token counts now expose the accurate
  `tokenAccounting: "estimated-utf8-byte-div-4"` field while retaining the
  `tokenMeasurement: "estimated-char-div-4"` compatibility label for 1.0.x
  consumers.
- **Context budget empty-file handling:** the offline file estimator now assigns
  a minimum one-token weight to empty files, preventing valid empty source files
  from causing the optimizer's minimum-token validation to fail.
- **Context budget input validation:** the core optimizer now rejects non-finite,
  fractional or negative budget/token/byte inputs before selection, keeping
  direct API callers under the same deterministic contract as the CLI.

- **Optional remote backend adapters:** added async Qdrant REST vector and
  read-only Memgraph Bolt graph adapters behind validated backend contracts.
  They hash ProjectMind namespaces, bound vectors/results/depth, parameterize
  remote values, enforce endpoint/credential boundaries, and keep drivers and
  network services out of the default offline installation.
- **Cross-platform Git diagnostics:** Git-backed churn, flag, insight, and
  autopilot probes now suppress expected non-repository stderr while preserving
  their existing fallback behavior; worktree namespace status also compares
  canonical Windows paths case-insensitively.
- **Branch/worktree graph isolation:** KnowledgeGraph now selects a stable
  ProjectMind project namespace for the active Git branch and linked worktree
  during startup. A new commit on the same branch remains in that namespace and
  is reported as a stale/current transition; a different branch or worktree
  cannot reuse the other checkout's file graph. Existing non-Git and legacy
  databases retain their previous current-project behavior.
- Added the `arbitrate_agents` MCP tool for deterministic multi-agent planning:
  it combines advisory locks, bidirectional merge/blast-radius evidence,
  indexed dependency ordering, conflict groups and file-sharding suggestions;
  its optional ledger record is payload-free and never writes source or Git
  state.
- Fixed debt snapshot refresh so unresolved detector findings cannot survive a
  later corrected run. Fast-tier complexity/size heuristics remain visible as
  low-severity advisory evidence, while explicit architectural contract errors
  are the only pattern-drift findings promoted to high severity.
- Fixed `mcp-init --verify` project-root detection for JSON/JSONC clients so
  escaped Windows paths, relative `.` pins, `cwd`, and environment entries are
  compared structurally instead of as serialized JSON text.
- Fixed `mcp-init --verify --handshake` for large MCP registries: the verifier
  now sends the required initialized notification, preserves multi-chunk JSON
  responses until a complete frame arrives, bounds incomplete-frame memory, and
  terminates the Windows child process tree after the check. Windows launches
  npm's `npx-cli.js` through Node directly, without a `cmd /c` shell wrapper.
- Fixed npx package-argument forwarding in the handshake verifier by using an
  explicit package separator before `mcp --profile core`; this prevents npm
  from consuming the profile option on Windows and POSIX environments.
- Removed the production-package `prepare` lifecycle build. Published tarballs
  already contain `dist`, so global installs no longer rebuild the package or
  trigger lifecycle-script warnings; source checkouts use `npm run build`
  explicitly.
- Changed Transformers.js and ONNX runtimes to optional peer providers so the
  default core/global install does not pull the native warning/advisory chain;
  explicit provider installation and deterministic simple-provider fallback
  remain supported without `--legacy-peer-deps`.
- Added validated SQLite database snapshots with `pm ledger backup` and
  explicit-confirmation `pm ledger restore --force`; integrity/schema checks,
  staged replacement, WAL/SHM cleanup and rollback protection are covered by
  hermetic tests.
- Fixed `pm mcp schema` so it is a finite alias for `pm mcp schemas` instead of
  accidentally entering the long-running MCP server path.
- Hardened benchmark ranking against duplicate result identities and added
  deterministic ROI variant comparisons, replay timeline summaries, and
  migration-version collision detection.
- Added a local-checkout benchmark corpus runner with immutable Git HEAD
  verification and explicit unknown/limitation reporting; missing or mismatched
  repositories never receive fabricated scores. Added an opt-in process-isolated
  MCP benchmark worker using shell-free argv and bounded child timeouts.
- Context, review, and Auto-Fix decisions now emit payload-free Evidence Ledger
  and Agent Time Machine receipts. Replay can safely reconstruct recorded context
  metadata and matching source ranges without treating current files as trusted
  or replaying code.
- `pm init` now has an explicit `--root` bootstrap path and creates missing
  local `.pmignore`, sparse `.projectmindrc.json`, and `.mcp.json` files
  idempotently; global/project configuration precedence is documented and
  tested.
- Added `pm config path|init|show|set` for safe layered configuration
  management, including sparse global config creation, schema-backed updates,
  atomic writes, redacted display, and doctor conflict/permission reporting.
- Review decisions now persist payload-free ledger and replay metadata with
  graph/policy hashes.

- Added the first Evidence Ledger slice: project-scoped, payload-free,
  hash-chained records with append-only SQLite protection, `pm ledger list`,
  `pm ledger verify`, `pm ledger export`, independent export verification,
  MCP `evidence_ledger`, and scan decision audit records.
- Added the first Context ROI slice: `pm budget`/`context-budget` and MCP
  `plan_context_budget` now expose task-aware estimated token savings and
  original-score relevance coverage with explicit non-billing limitations;
  optional input price estimates are reported separately and rounded
  deterministically.
- Added the first calibrated-risk slice: `pm risk`/`pm risk --pr` and MCP
  `predict_impact_risk` now expose deterministic structural evidence, a
  beta-smoothed probability, calibration metadata, and an uncertainty interval;
  fewer than 10 outcomes are explicitly reported as `insufficient-data`.
- Added the first taint-to-exploit slice: `pm exploit-path` and MCP
  `exploit_path` expose deterministic AST source-to-sink steps with sanitized
  identities, line/column evidence, and explicit no-execution/no-PoC limits.
- Added the first Agent Time Machine slice: payload-free append-only replay
  metadata, `pm replay`/`replay record`, and MCP replay record/query surfaces
  with source/graph drift classification.
- Added an opt-in live Architecture Guardian boundary to `pm watch`; contract
  violations are reported before graph refresh and `--guardian-block` can stop
  acceptance of an invalid update without modifying the user's file.
- Added evidence-gated Auto-Fix personalization: `pm autofix record/recommend`
  and MCP feedback tools store project/agent-scoped append-only outcomes with
  policy version, optional decay, Wilson uncertainty, logical reset, and
  explicit opt-out controls. Small or mixed samples never become automatic
  approval.
- Project-scoped scan profiles and agent sessions/memory now prevent
  cross-project reporting and session leakage in shared SQLite stores.
- Made `mcp-init` reuse an existing OpenCode `.jsonc` or Kilo `.json` config
  instead of creating a second client config, and made repeated initialization
  idempotent with user settings preserved.
- Removed duplicate success checkmarks from `init`, `mcp-init`, and autopilot
  CLI output.
- Removed a raw NUL byte from the import-resolution cache source while
  preserving its runtime cache-key delimiter.
- Fixed top-level `graph --format` handling so Commander does not overwrite an
  explicitly selected format with the root command's absent option value.
- Replaced silent fallback catches with typed, debug-level observability and
  made intentional no-op migration/test callbacks explicit without changing
  their behavior.
- Split MCP HTTP transport lifecycle from its security policy and hardened
  authorization to return strict booleans with length-safe token comparison;
  invalid credentials and malformed requests are now rejected deterministically.
- File watchers now remove deleted source files from the knowledge graph and
  vector index, report `removed` separately from `failed`, and never resurrect
  an intentionally unregistered MCP watch.
- Split the MCP synchronization implementation into focused watcher, file
  status, registration, and context modules while preserving `sync.ts` as the
  public compatibility façade; context-enrichment failures are now observable
  in structured results instead of being silently discarded.
- Extended semantic MCP retrieval from files to indexed functions/classes via
  `scope: "symbol"`, with source locations, provider/index dimensions,
  malformed-vector diagnostics, persisted provider/model manifests, and
  explicit freshness limitations. Missing or incompatible manifests now
  downgrade evidence instead of allowing unverified semantic claims.
- Made configured embedding providers effective during scan indexing for files
  and symbols, with a shared dimension contract and no silent batch truncation.
- Fixed dimension-sensitive token-vector caching and prevented non-finite
  similarity scores from entering search or redundancy results.
- Aligned the public embedding provider types and MCP schema with all five
  supported providers (`simple`, `openai`, `transformers`, `unixcoder`,
  `codebert`); unavailable optional providers now report the active fallback.
- Retired obsolete UI integrations, their CI/release jobs, and the embedded
  `pm serve` command.
- Removed obsolete planning, temporary, and generated agent artifacts from the
  repository surface.

## [1.0.2] - 2026-09-07

- Reduced the parser surface to TypeScript and JavaScript using the TypeScript
  Compiler API; removed obsolete multi-language grammar dependencies.
- Removed the old peer-dependency override requirement and verified clean
  `npm ci` installation from the lockfile.
- Deduplicated MCP initialization targets and removed the retired editor
  integration from source, packaging, and workflows.
- Fixed the circular-dependency command so its service context cannot create a
  nested command-named state directory.
- Fixed the CLI launcher packaging and Windows-safe ESM loading; global install
  smoke tests now expose both `pm` and `projectmind` at 1.0.2.
- Kept MCP stdio stdout protocol-safe by routing direct-server diagnostics to
  stderr.
- Reduced published package assets to runtime CLI assets, shrinking the
  dry-run payload to approximately 1.1 MB.
- Corrected fast coherence function-name matching to avoid false positives from
  TypeScript union types.
- Centralized project file boundaries in the root `.pmignore`; `.projectmindrc.json`
  now contains runtime configuration only.
- Prevented test files, self-matches, symmetric pairs, and tiny files from
  polluting production redundancy debt reports.

## [1.0.1] - 2026-09-06

- Fixed web lockfile synchronization for clean CI installs.

## [1.0.0] - 2026-09-06

Production-ready stable release: hardened migrations, deterministic review
history, cross-platform path handling, complete MCP initialization for major
coding agents, and verified CLI/MCP release gates.

- Centralized multi-language parser registration with capability reporting.
- Added versioned review history with deterministic finding fingerprints and resolved/open lifecycle.
- Standardized CLI raw and JSON output through the output abstraction.
- Added cross-platform path confinement safeguards.

## [0.9.0] - 2026-08-31

v0.9.0 — intent-driven search, predictive impact, hardening & coverage expansion (F1–F7).

### Added
- **Intent-driven semantic navigation (F1)** — hybrid search combining semantic embeddings, structural graph traversal and intent classification (`src/core/search/intent-engine.ts`).
- **Predictive impact analysis (F2)** — static analysis + historical failure correlation to predict test breakage before refactor (`src/core/predictive/impact-predictor.ts`, risk levels).
- **Autopilot pre-commit gates** — configurable genome threshold, timeouts and detailed reporting (`src/cli/commands/autopilot.ts`); **API surface gate (Gate 5)** against `HEAD~1` with `risk-levels` extraction and `--allow-breaking-api` flag.
- **HTTP/OAuth security layer** extracted to `src/mcp/http-security.ts`.
- **Test coverage expansion** — 946 new tests: coherence analysis (51), LLM providers (54), cache system (40 + LRU/persistence 62), fingerprint/semantic (20+), knapsack/context assemblers (77), genome/debt persistence/skill catalog/engine (186).

### Changed
- Extracted shared `RiskLevel` types to `src/core/predictive/risk-levels.ts` (eliminates duplication across autopilot/impact/mcp).
- Improved type safety: `(node as any).name?.text` replaced with `getDeclarationName()` type guard in `fingerprint.ts`.
- Made `max_tokens`, Ollama URL, LLM `maxTokens` and server bind IPs configurable via env/config.

### Fixed
- Hardened `impact-predictor` against path traversal / null-byte injection in git history lookup.
- Fixed `process.exit` in core modules → `throw`/`process.exitCode` via `asyncHandler`; removed `process.exit` from `mcp-server` signal handlers.
- Replaced silent `catch {}` blocks with structured `logger.warn/error` across `watcher`, `vector-index`, `context`, `intent-engine`, `debt/tracker`, `deep-coherence` and `user-context` modules.
- Replaced `console.*` in non-CLI source files with project `logger` (`sbom`, `storage`, `skills/engine`, `mcp/tools`, etc.).
- Moved `src/test-helpers/` → `tests/test-helpers/` and removed `src` test files (`__tests__`, `graph.test.ts`); cleaned `tests` build artifacts.
- Extracted magic numbers to named constants: `MAX_TOKENS_PER_CHUNK`, `MAX_FILE_LINES`, `DEFAULT_MAX_TOKENS`, `PURGE_*`, `PERSIST_INTERVAL_MS`, `COGNITIVE_LOAD_THRESHOLD`, etc.

### Security
- Path traversal hardening in `ImpactPredictor` (`..` / null-byte rejection).

## [0.8.0] - 2026-08-27

Living codebase intelligence — roadmap A+B: multi-language AST analysis,
visual diagrams + MCP Apps, OAuth 2.0 Dynamic Client Registration, evidence
based agent skill recommendations, 3-way team-memory merging, and agent
native config generation.

### Added
- **Multi-language analysis (A2)**: tree-sitter AST parsing for Go, Rust,
  Python, Java, C#, C++, Ruby and TypeScript — `structural_search` and
  pattern extraction now work across languages with native parser byte
  offsets (previously TypeScript-only).
- **Symbol language service** (`src/parser/language-service.ts`): cross-file
  symbol resolution powering def/ref navigation in every supported language.
- **Visual diagrams + MCP Apps (B3)**: `pm graph-render` emits SVG **and**
  PNG (zero-dependency hand-rolled PNG encoder) dependency diagrams; the
  `src/mcp/apps/` module lets MCP tools render the same diagrams.
- **OAuth 2.0 Dynamic Client Registration (B4)**: RFC 7591 `/oauth/register`
  + RFC 6749 client-credentials `/oauth/token` endpoints on the HTTP
  transport (`PROJECTMIND_OAUTH_ENABLED`); RFC-compliant client metadata
  validation, one-time `client_secret`, scoped registration.
- **Evidence-based skill recommendations (B5)**: `pm skill-recommend`
  rewritten to derive per-agent proficiency from REAL interaction history
  (agent sessions, `files.agent_touched_by`, session decisions, coding
  fingerprint) instead of a hardcoded catalog; `--write` generates a
  personalized `skills/<agent>/SKILL.md` explaining what each of 21 skills
  helps with and the exact commands to apply it.
- **Team-memory 3-way merge (A1)**: concurrent `store_team_memory` writes
  are reconciled Git-style — overlapping-safe values merge, genuine conflicts
  keep the stored value and return a resolution suggestion instead of
  silently overwriting.
- **Agent-native config generators**: `pm`-side generators build Claude Code
  SKILL.md and other agent configs (`src/cli/generators/agent-configs.ts`).
- **MCP tool-list cache hints**: `_meta` TTL/cache-scope extensions per the
  MCP spec so spec-compliant clients can cache `tools/list` results.

### Changed
- `skill-recommend` output now includes "Why it helps" per skill, evidence
  files, estimated effort (gap × 20h), and priority (critical/high/medium/low)
  across text, JSON and HTML formats.
- HTTP transport: `/mcp`, `/oauth/*` and legacy routes are dispatched through
  a single handler with rate limiting and static-token auth preserved.

### Fixed
- `check_coherence` rejected every request from clients that send a partial
  `_meta` (e.g. Kilo Code) — the tool now mirrors the transport edge and only
  enforces the envelope when the client advertises `protocolVersion`.
- Skill evidence never lists the same file twice within one skill
  (typescript double-push + module-path dedup).
- Non-TypeScript parser offsets corrected to native tree-sitter byte
  accounting (structural-search findings were silently dropped before).

### Security
- OAuth client secrets are stored as SHA-256 digests only; the plaintext is
  returned exactly once at registration.
- `/oauth/register` is protected by the static bearer token per RFC 7591 §2.1
  (token endpoint stays open for client-credentials flow).

## [0.7.0] - 2026-08-26

From analysis to action: agents get progress feedback during long operations,
real graph algorithms over the knowledge graph, live file watching, task-aware
context ranking, code that actually changes (auto-fix), multi-agent file
coordination with merge-risk prediction, and semantic team-memory search — plus
a critical data-integrity migration.

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
while the knowledge graph becomes part of agent workflows.

### Added
- **`pm autopilot pre-commit`**: enforced quality gate with real exit codes —
  high-severity debt must be zero, architectural cycles zero, genome score at
  or above threshold (`--min-genome`, default 70%). `--format json` for CI.
- **`pm autopilot install-hooks [--uninstall]`**: installs a marked git
  `pre-commit` hook running the gate — agents AND humans cannot skip it;
  refuses to touch foreign hooks on uninstall.
- **Living Context Window (v1)**: `sync_context` pull automatically enriches
  responses with the reported current file's dependency closure and similar
  files from embeddings.
- **Predictive refactoring signal**: refactor-roi compares 30-day vs 90-day
  churn windows and flags candidates whose churn is *accelerating* before
  they become hotspots.

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
  claude-code, cursor, opencode, or windsurf with merge support
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
Older 0.8.x builds needed a temporary npm peer-dependency workaround because
of their grammar packages. Current releases use standard npm dependency
resolution without an override.

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
