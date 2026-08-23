# MCP Integration Guide

ProjectMind exposes **two complementary surfaces** to coding agents:

1. **Dedicated MCP tools** (28) — typed inputs for hot paths
2. **`run_cli` bridge tool** — programmatic access to the *entire* CLI surface
   (50 commands) for capabilities without a dedicated tool

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
    "projectmind": {
      "type": "local",
      "command": ["npx", "-y", "@emirhanturker/projectmind", "mcp"],
      "environment": { "PROJECTMIND_ROOT": "." }
    }
  }
}
```

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
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` | Enables deep-tier LLM analysis for the matching provider |
| `CLAUDE_API_KEY` | Alias accepted for Anthropic |

Without an LLM key the server runs fully functional **fast-tier** analysis.

---

## Dedicated Tools (28)

| Group | Tools |
|---|---|
| Coherence & context | `check_coherence`, `get_context`, `check_architecture`, `analyze_impact`, `suggest_refactor` |
| Knowledge graph | `scan_project`, `get_file_status`, `register/unregister_file_watch`, `sync_context` |
| Imports & structure | `trace_imports`, `find_circular_deps`, `resolve_import`, `resolve_path`, `find_file_by_import`, `get_dependents`, `get_dependency_graph`, `structural_search` |
| Memory & sessions | `store_memory`, `get_memory`, `start/end/get_agent_sessions`, `store_team_memory`, `get_team_memories` |
| Reports | `debt_report`, `scale_report`, `genome_score` |
| Projects | `list/create/switch/delete_project` |
| Data-flow & taint | `record_data_flow`, `get_data_flows`, `clear_data_flows`, `analyze_taint` |
| Tracing | `ingest_trace` (+ get/clear dynamic calls) |
| Embeddings | `init_embedding_provider`, `generate_embedding`, `get_embedding_provider` |
| Bridge | **`run_cli`** (below) |

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
`deps-fresh`, `flags`, `secrets-life`, `onboard`, `embed init/stats`.

---

## Recommended agent workflow

1. `scan_project` once after cloning (or let the extension auto-scan)
2. Before editing: `get_context` + `analyze_impact`
3. After editing: `check_coherence` (fast) or `run_cli ["doctor","scan-health"]`
4. Periodically: `debt_report` + `genome_score`; `find_circular_deps`
5. Long tasks: `start_session` … `sync_context` … `end_session`
