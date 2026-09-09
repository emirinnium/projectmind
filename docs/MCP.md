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
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` | Enables deep-tier LLM analysis for the matching provider; `OPENAI_API_KEY` also enables the configured OpenAI embedding provider |
| `CLAUDE_API_KEY` | Alias accepted for Anthropic |

Without an LLM key the server runs fully functional **fast-tier** analysis.

### Project file boundary

All project-source discovery uses the root `.pmignore` file plus ProjectMind's
built-in safety exclusions. The same boundary is applied by CLI scans, MCP
tools, watchers, coherence/contract checks, and integrity checks. Keep these
rules in `.pmignore`; `.projectmindrc.json` is for runtime configuration and
does not define file ignores.

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
| Reports | `debt_report`, `scale_report`, `genome_score` |
| Evidence & reproducibility | `prove_claim`, `verify_freshness`, `kg_query` (`feature-map`) |
| Projects | `list_projects`, `create_project`, `switch_project` |
| Data-flow & taint | `record_data_flow`, `get_data_flows`, `clear_data_flows`, `analyze_taint` |
| Tracing | `ingest_trace` (+ get/clear dynamic calls) |
| Embeddings | `init_embedding_provider`, `generate_embedding`, `get_embedding_provider` |
| Bridge | **`run_cli`** (below) |

`search_intent` returns the evidence level beside each hybrid result:
`measured` means the persisted/query vectors were compared, `rank-derived`
means only the graph result order was available, and `structural-heuristic`
means the file was added through an import/dependent relationship. The labels
keep navigation useful without overstating what was actually measured.

> **Naming across clients.** This document uses the server-declared tool names
> (no prefix). opencode prefixes every MCP tool with the server name, so the
> same tools are exposed there as `projectmind_*` — e.g. `run_cli` becomes
> **`projectmind_run_cli`**, `get_context` becomes `projectmind_get_context`.
> Claude Code, Cursor and Windsurf expose them without the prefix.

## `run_cli` Bridge — full CLI surface from MCP

```jsonc
// example: project health with live metrics
{ "name": "run_cli", "arguments": { "args": ["health", "--json"] } }

// example: SBOM generation
{ "name": "run_cli", "arguments": { "args": ["sbom", "--format", "spdx", "-o", "sbom.spdx"] } }

// example: unresolved-import analysis with alias suggestions
{ "name": "run_cli", "arguments": { "args": ["doctor", "fix-imports"] } }
```

Rules: shell disabled (argv array only), cwd pinned to `PROJECTMIND_ROOT`,
stdout/stderr tails capped, default timeout 120 s (`timeoutMs` override),
recursive `mcp` launch blocked.

CLI-only capabilities reachable through the bridge (no dedicated tool):
`doctor scan-health/clean-debt/rebuild-index/fix-imports`, `report`, `layers`,
`audit`, `license check/report`, `sbom sign/validate`, `churn`, `api-surface`,
`dedup`, `heatmap`, `ownership`, `adr add/list/search`, `testgen`,
`docgen readme/api`, `migrate check-deps/jest-to-vitest/typescript`,
`skill-recommend`, `context-budget`, `contract-test generate/run`,
`trace convert/show/events/static-missed/clear`, `refactor`, `refactor-roi`,
`graph circular/feature-map/snapshot`, `proof verify`, `deps-fresh`, `flags`,
`secrets-life`, `onboard`, `embed init/stats`.

---

## Recommended agent workflow

1. `scan_project` once after cloning
2. Before editing: `get_context` + `analyze_impact`
3. After editing: `check_coherence` (fast) or `run_cli ["doctor","scan-health"]`
4. Periodically: `debt_report` + `genome_score`; `find_circular_deps`
5. Long tasks: `start_session` … `sync_context` … `end_session`

If `.projectmindrc.json` selects `openai`, `transformers`, `unixcoder`, or
`codebert` embeddings, `scan_project` applies that provider to the persisted
file and symbol index. Rescan after changing provider/model/dimension settings;
the response exposes fallback limitations when an optional provider is not
available. Each successful scan also stores a project-scoped provider/model/
dimension manifest. `semantic_search` compares that manifest with the active
query runtime and downgrades its evidence when the manifest is missing,
malformed, or incompatible; it never treats matching vector dimensions alone
as proof that two semantic spaces are comparable.

### Evidence and drift guard

Use `prove_claim` only with exact source paths. It returns `source-backed` when
the cited files' content hashes match the graph, while explicitly leaving AST,
typecheck, and runtime verification false. Use `verify_freshness` before relying
on a cached analysis after edits. For a portable baseline, create a CLI graph
snapshot and verify it later; a matching snapshot proves graph identity, not
application behavior.
