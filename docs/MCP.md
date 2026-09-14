# MCP Integration Guide

ProjectMind exposes **two complementary surfaces** to coding agents:

1. **Dedicated MCP tools** (the explicit registered surface) — typed inputs for hot paths
2. **`run_cli` bridge tool** — programmatic access to the CLI surface for
   capabilities without a dedicated tool

---

## Quick Connect

### Claude Code
```bash
# project scope (shared with the team via .mcp.json in repo root)
claude mcp add projectmind -- npx -y @emirhanturker/projectmind@latest mcp

# or user scope
claude mcp add --scope user projectmind -- npx -y @emirhanturker/projectmind@latest mcp
```

### Cursor
`~/.cursor/mcp.json` (or project `.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "projectmind": {
      "command": "npx",
      "args": ["-y", "@emirhanturker/projectmind", "mcp"],
      "env": { "PROJECTMIND_ROOT": "${workspaceFolder}" }
    }
  }
}
```

### OpenCode
`opencode.json`:
```json
{
  "mcp": {
    "servers": {
      "projectmind": {
      "type": "local",
      "command": ["npx", "-y", "@emirhanturker/projectmind", "mcp"],
      "cwd": "<absolute-project-root>",
      "environment": { "PROJECTMIND_ROOT": "<absolute-project-root>" },
      "disabled": false
      }
    }
  }
}
```

### Codex, Devin, Antigravity, and Kilo Code

Run `pm mcp-init codex`, `pm mcp-init devin`, `pm mcp-init antigravity`, or
`pm mcp-init kilo-code`. The command merges the client-specific project-local
manifest and an instruction block while preserving unrelated configuration.
It understands JSONC comments/trailing commas for OpenCode and Kilo files,
does not duplicate an existing ProjectMind block, and uses `--force` only to
refresh a previously generated ProjectMind block. Existing custom `AGENTS.md`,
`CLAUDE.md`, and other instructions are never replaced wholesale.

### Windsurf / any stdio-MCP client
Same shape as Cursor: `command=npx`, `args=["-y","@emirhanturker/projectmind","mcp"]`.

### From a cloned repository (development)
Point at the local build instead of npm:
```json
{
  "command": "node",
  "args": ["<repo>/dist/cli.js", "mcp"],
  "env": { "PROJECTMIND_ROOT": "<repo>" }
}
```

> **Windows note:** npm installs `projectmind.cmd` shims; official SDK-based
> clients launch them through `cmd /c` automatically. If you spawn manually,
> prefer the `node <…>/dist/cli.js mcp` form shown above.

---

## Environment

| Variable | Purpose |
|---|---|
| `PROJECTMIND_ROOT` | Project root the server scans/stores under (**set this**) |
| `PROJECTMIND_TOOLS` | Tool surface profile: `core` (default), `review`, `security`, `maintenance`, or `all`/`full` (dedicated tools plus the full `pm_*` CLI-parity surface). `run_cli` stays available in every non-full profile where listed. |
| `PROJECTMIND_HTTP_PORT` | When set, the server starts a **stateless Streamable HTTP** endpoint instead of stdio: `POST http://127.0.0.1:<port>/mcp` (JSON responses; GET returns 405). For remote/team-shared deployments behind plain load balancers. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` | Enables deep-tier LLM analysis for the matching provider; `OPENAI_API_KEY` also enables the configured OpenAI embedding provider |
| `CLAUDE_API_KEY` | Alias accepted for Anthropic |

Without an LLM key the server runs fully functional **fast-tier** analysis.

`openrouter` is an explicit OpenAI-compatible provider. Configure it in
`.projectmindrc.json` with `llm.provider: "openrouter"` and a model ID accepted
by OpenRouter; its endpoint is restricted to `https://openrouter.ai/api/v1`.
For reasoning-capable OpenRouter models, `llm.reasoning` may explicitly set
`effort` (`xhigh`, `high`, `medium`, `low`, `minimal` or `none`), `maxTokens`
and `exclude`. ProjectMind forwards these controls only to OpenRouter and keeps
provider reasoning separate from final `content`; a reasoning-only response is
reported as `responseMode: "reasoning-only"` rather than being promoted to an
answer.

### Project file boundary

All project-source discovery uses the root `.pmignore` file plus ProjectMind's
built-in safety exclusions. The same boundary is applied by CLI scans, MCP
tools, watchers, coherence/contract checks, and integrity checks. Keep these
rules in `.pmignore`; `.projectmindrc.json` is for runtime configuration and
does not define file ignores.

Most MCP tools also accept an optional numeric `projectId` selector. It scopes
that single request to the persisted project and does not change the process's
global project selection; graph, root, scale, debt and coherence dependencies
are resolved inside the request scope. `list_projects`, `create_project` and
`switch_project` remain global project-management operations, so their
existing behavior is unchanged.

`pm init` bootstraps missing project-local `.pmignore`, sparse
`.projectmindrc.json`, and `.mcp.json` files idempotently. The local runtime
config intentionally overrides matching values from the user-level global
config; the effective order is defaults → global config → project config →
environment → CLI. `.pmignore` remains independent and is the only
user-controlled source-discovery ignore file.

The layered config can be inspected or initialized with `pm config path`,
`pm config init --global`, and `pm config show --effective`. Schema-backed
updates use `pm config set --global <key> <value>`; values are validated before
an atomic write and secret fields are redacted in display output.

### Agent setup notes

- `pm init-mcp claude-desktop` writes the GUI app's global config
  (`%APPDATA%\Claude\claude_desktop_config.json` on Windows,
  `~/Library/Application Support/Claude/...` on macOS,
  `~/.config/Claude/...` on Linux) and pins `PROJECTMIND_ROOT` to the
  directory where you ran the command.
- `pm init-mcp windsurf` targets Windsurf's official global config at
  `~/.codeium/windsurf/mcp_config.json` — click *Refresh* in the MCP panel
  afterwards.
- Destructive operations (`project delete`, `debt clear*`, `data-flow clear`,
  `trace clear`, `doctor rebuild-index`, root `mcp`/`init`) are blocked on the
  entire MCP surface (dedicated bridge **and** generated `pm_*` tools).

### Annotations, Resources & Prompts

- Every dedicated tool and generated CLI-parity tool carries explicit
  `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`
  annotations. Values are classified from the operation's real side effects;
  state-changing tools are not advertised as read-only.
- Local analysis tools set `openWorldHint: false`; tools that can invoke an
  external LLM, embedding provider, or npm registry set it to `true`.
- Resources: `pm://schema` (live DB tables), `pm://config` (secrets masked),
  `pm://stats` (project statistics), and `pm://profiles` (deterministic tool
  profile discovery).
- Prompts: `impact-first-refactor`, `pre-commit-checklist`, `debt-triage`,
  `explain-file-context`.

---

## Dedicated Tools

| Group | Tools |
|---|---|
| Coherence & context | `check_coherence`, `get_context`, `check_architecture`, `analyze_impact`, `suggest_refactor` |
| Knowledge graph | `scan_project`, `get_file_status`, `register/unregister_file_watch`, `sync_context` |
| Imports & structure | `trace_imports`, `find_circular_deps`, `resolve_import`, `resolve_path`, `find_file_by_import`, `get_dependents`, `get_dependency_graph`, `structural_search` |
| Memory & sessions | `store_memory`, `get_memory`, `start/end/get_agent_sessions`, `store_team_memory`, `get_team_memories` |
| Multi-agent coordination | `agent_locks`, `predict_merge_risk`, `arbitrate_agents` |
| Reports | `debt_report`, `scale_report`, `genome_score` |
| Evidence & reproducibility | `prove_claim`, `verify_freshness`, `evidence_ledger`, `record_evidence`, `agent_replay`, `record_replay_event`, `kg_query` (`feature-map`) |
| Projects | `list_projects`, `create_project`, `switch_project` |
| Data-flow & taint | `record_data_flow`, `get_data_flows`, `clear_data_flows`, `analyze_taint`, `exploit_path` |
| Auto-Fix learning | `auto_fix`, `record_autofix_feedback`, `recommend_autofix`, `set_autofix_feedback_opt_out`, `reset_autofix_feedback` |
| Tracing | `ingest_trace` (+ get/clear dynamic calls) |
| Embeddings | `init_embedding_provider`, `generate_embedding`, `get_embedding_provider` |
| Bridge | **`run_cli`** (below) |

`search_intent` returns the evidence level beside each hybrid result:
`measured` means the persisted/query vectors were compared, `rank-derived`
means only the graph result order was available, and `structural-heuristic`
means the file was added through an import/dependent relationship. The labels
keep navigation useful without overstating what was actually measured.

`review_project` plans deterministic bundles and executes them with the
policy's `concurrency`, `bundleTimeoutMs` and `bundleRetries` limits. Its
response includes per-bundle status, attempts and duration; a failed or timed
out bundle makes coverage incomplete and is never silently treated as reviewed.

`arbitrate_agents` is the multi-agent planning layer: submit two or more
agent/file plans before parallel edits and it returns pairwise structural and
bounded content risk, active-lock collisions, dependency-aware rebase order,
conflict groups, and isolated-file shard suggestions. It is advisory and does
not write source or git state. By default it records only input/result hashes
and bounded summary metadata in the Evidence Ledger; set `recordEvidence=false`
when a strictly read-only invocation is preferred.

`evidence_ledger` lists, exports, or verifies the local append-only audit chain.
Ledger records contain hashes and bounded structural summaries, never source
payloads or credentials. `operation="verify"` is the default and reports the
affected record IDs when a chain link or record hash is inconsistent.
`operation="export"` returns a versioned payload-free bundle that can be saved
and independently checked with `pm ledger verify --export <file>`; export
verification checks project identity, strict record order, previous hashes,
record hashes, and malformed hash values without opening the source database.
The ledger records successful MCP `scan_project`, `get_context`, review, and
Auto-Fix decision metadata. `get_context` is therefore explicitly classified
as a derived-state write in the registry annotations; it stores hashes and
bounded paths only, never source text, task text, credentials, or diffs.

`plan_context_budget` retains the backwards-compatible `roi.tokenMeasurement`
label `estimated-char-div-4` for heuristic consumers, and additionally reports
the accurate `roi.tokenAccounting` value `estimated-utf8-byte-div-4`. For an explicit provider-backed count, pass
`tokenizer="transformers"` and optionally `tokenizerModel`; the optional
Transformers.js tokenizer then produces `provider-transformers`,
`status="measured"`, and the model identifier. If that optional provider cannot
be loaded, the request fails with an actionable install/fallback message rather
than silently claiming a measured result. An optional `inputPricePer1k` input
produces local USD estimates; absent pricing remains `null` and is listed as a
limitation rather than being guessed. For a repeatable auditable price, use a
config-backed record with source, effectiveAt, and optional expiresAt metadata;
expired or future-dated records are excluded from cost arithmetic.

`plan_context_budget` also returns an explicit `roi` object. It reports the
candidate/selected file and token arithmetic, estimated saved tokens, original
relevance coverage, measured source-byte arithmetic when every candidate has a
byte size, and limitations. `roi.status="estimated"` is used when the
heuristic is active; `roi.status="measured"` only means the selected tokenizer
counted the source. ProjectMind still does not claim exact billing savings
without provider pricing/overhead data. The CLI exposes the same calculation as `pm budget` (alias of
`pm context-budget`) and accepts `--task` for task-type boosts. It also supports
`--tokenizer heuristic|transformers` and `--tokenizer-model <model>`.

The response additionally includes `planComparisons`. The full-file and
budgeted-file entries contain the same ROI arithmetic; byte-range,
canonical-example and graph-closure entries are explicitly marked unavailable
unless a real plan for that variant was supplied. An unavailable variant never
appears as zero tokens or fabricated savings.

`predict_impact_risk` includes the calibrated-risk baseline alongside the
existing predicted-break list. Its evidence fields identify dependency,
change-shape, churn, debt, and recorded-outcome signals; `calibration` carries
the algorithm/version and observation count; `confidenceInterval` is widened to
`[0,1]` while fewer than 10 outcomes are available, and `status` is
`insufficient-data`. This is a transparent estimate, not proof that a test or
deployment will fail.

The pure calibration metric is also available as `pm risk calibrate <file>`.
The JSON file must contain either an array or `{ "observations": [...] }`, with
each observation providing an id, a `predictedProbability` from 0 to 1, and a
boolean `failureOccurred`. The command reports Brier score and fixed bins only
for the labels supplied; an empty corpus makes no accuracy claim.

`exploit_path` is the safe source-to-sink companion to `analyze_taint`. It
returns sanitized identities, AST line/column steps, and explicit
`vulnerabilityProven=false`/no-reproduction semantics. It does not run the
source, invoke a sink, create a curl/PoC payload, or make a network request.
Set `includeProject=true` to follow the bounded forward closure of resolved
static ES imports from the requested indexed entry file into named exported
JS/TS functions. Unrelated indexed files are excluded, and cross-file
candidates include both the caller and sink file paths. Dynamic dispatch,
framework routes, computed CommonJS imports, runtime bundles, and
exploitability remain unproven.

`record_replay_event` is the explicit write surface for Agent Time Machine
metadata. It stores only bounded outcome fields and hashes; use `agent_replay`
to list/verify those events and classify source/graph drift. Pass
`reconstructContext=true` to request a safe comparison of recorded context
paths against the current project. The result is `recorded`, `diverged`, or
`unavailable`; source content is returned only when the current hash exactly
matches the recorded hash and it remains marked as untrusted content. This is
reconstruction, not execution replay, and it never edits files.

The response also includes a payload-free `timeline` summary with canonical
event ordering, time bounds, duration, event-type counts and drift-status
counts. A session timeline is descriptive metadata, not a claim that the
original agent execution can be replayed.

Ledger exports include `totalRecords` and `complete`. Independent verification
rejects a bounded/incomplete export as a backup even when the visible prefix’s
hashes are internally valid. The CLI can persist a complete bounded export with
`pm ledger export --output .projectmind/ledger-export.json`; the path remains
project-confined and atomic.

For database-level recovery, use `pm ledger backup --output
.projectmind/pm-knowledge.db.backup`. This creates a consistent SQLite snapshot
and validates it read-only. `pm ledger restore --input
.projectmind/pm-knowledge.db.backup --force` replaces the closed active index
only after the snapshot passes integrity/schema checks; run `pm scan --full`
afterward before trusting derived graph data. Database restore is deliberately
CLI-only and is not exposed through the MCP write surface.

Auto-Fix preview/apply decisions also emit payload-free ledger and replay
receipts. The receipt distinguishes preview from apply and records source and
result hashes, so an edit can be audited without persisting the source or diff.

`record_autofix_feedback` stores only the fixer id, accepted/rejected/skipped
outcome, policy version, optional agent scope, and an optional source hash. It
never stores source text or secret values. `recommend_autofix` uses explicit
minimum-sample and optional half-life (`decayDays`) settings; small or mixed
history remains `insufficient-evidence` instead of being treated as approval.
Use `set_autofix_feedback_opt_out` to disable collection for a project/agent
scope. `reset_autofix_feedback` creates an auditable logical reset: old rows
are retained, but recommendations start after the reset boundary.

> **Naming across clients.** This document uses the server-declared tool names
> (no prefix). opencode prefixes every MCP tool with the server name, so the
> same tools are exposed there as `projectmind_*` — e.g. `run_cli` becomes
> **`projectmind_run_cli`**, `get_context` becomes `projectmind_get_context`.
> Claude Code, Cursor and Windsurf expose them without the prefix.

## `run_cli` Bridge — approved CLI views from MCP

```jsonc
// example: project health with live metrics
{ "name": "run_cli", "arguments": { "args": ["health", "--json"] } }

// example: SBOM generation
{ "name": "run_cli", "arguments": { "args": ["sbom", "--format", "spdx", "-o", "sbom.spdx"] } }

// example: read-only project health sweep
{ "name": "run_cli", "arguments": { "args": ["doctor", "scan-health"] } }
```

Rules: shell disabled (argv array only), cwd pinned to `PROJECTMIND_ROOT`,
stdout/stderr tails capped, default timeout 120 s (`timeoutMs` override),
recursive `mcp`/`init` roots blocked. The bridge is default-deny: it exposes
only the read-oriented roots listed by the server and only the explicitly
approved subcommands (`doctor scan-health`, `license check|report`,
`migrate check-deps`, `graph circular|feature-map|snapshot`, and
`proof verify`). Other arguments, positional file/query arguments, and
state-changing subcommands are rejected. Use the dedicated typed MCP tools
for operations such as architecture export, symbol references, search, and
mutating workflows.

---

## Recommended agent workflow

1. `scan_project` once after cloning
2. Before editing: `get_context` + `analyze_impact`
3. After editing: `check_coherence` (fast) or `run_cli ["doctor","scan-health"]`
4. Periodically: `debt_report` + `genome_score`; `find_circular_deps`
5. Long tasks: `start_session` … `sync_context` … `end_session`

For save-time architecture checks, run the CLI watcher with `pm watch
--guardian`. Add `--guardian-block` only when contract errors should prevent
the changed file from being accepted into the live graph; the watcher never
rewrites the user's source file.

If `.projectmindrc.json` selects `openai`, `transformers`, `unixcoder`, or
`codebert` embeddings, `scan_project` applies that provider to the persisted
file and symbol index. Rescan after changing provider/model/dimension settings;
the response exposes fallback limitations when an optional provider is not
available. Each successful scan also stores a project-scoped provider/model/
dimension manifest. `semantic_search` compares that manifest with the active
query runtime and downgrades its evidence when the manifest is missing,
malformed, or incompatible; it never treats matching vector dimensions alone
as proof that two semantic spaces are comparable.

The transformer and ONNX runtimes are optional peer providers, so a normal
ProjectMind install does not download native embedding dependencies. Install
`@huggingface/transformers` and `onnxruntime-node` explicitly in the same local or
global scope only when those providers are required; the deterministic
`simple` provider remains the default fallback.

### Evidence and drift guard

Use `prove_claim` only with exact source paths. It returns `source-backed` when
the cited files' content hashes match the graph, while explicitly leaving AST,
typecheck, and runtime verification false. Use `verify_freshness` before relying
on a cached analysis after edits. For a portable baseline, create a CLI graph
snapshot and verify it later; a matching snapshot proves graph identity, not
application behavior.
