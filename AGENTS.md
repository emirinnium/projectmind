# AGENTS.md — ProjectMind Codebase Intelligence Rules

## Overview

You have access to ProjectMind MCP tools for persistent codebase intelligence.
These tools give you a live knowledge graph of the entire project: file relationships,
import chains, technical debt, coherence analysis, and cross-session memory.

**Use them proactively. Do not wait to be asked.**

> **Tool naming across clients.** The examples below use opencode naming, which
> prefixes MCP tools with the server name: `projectmind_get_context`,
> `projectmind_run_cli`, etc. On clients that do NOT prefix by server
> (Claude Code, Cursor, Windsurf) drop the `projectmind_` prefix and use
> `get_context`, `run_cli`, etc. OpenCode only has the `projectmind_*` names —
> calling the bare name (e.g. `run_cli`) fails with "unavailable tool".

---

## MANDATORY WORKFLOWS

### 🔍 BEFORE touching any file
```
projectmind_get_context { filePath }     → understand imports, dependents, structure
projectmind_analyze_impact { filePath }  → know who breaks if you change this
```

### ✏️ AFTER every file edit/save
```
projectmind_check_coherence { code, filePath, fastOnly: true }   → instant quality gate
```
If verdict is "warn" or "fail": read `suggestions`, fix before moving on.

### 📝 BEFORE proposing any commit
```
projectmind_debt_report {}            → check high-severity debt = 0
projectmind_find_circular_deps {}     → verify no new cycles
projectmind_genome_score {}           → confirm score ≥ 70%
projectmind_run_cli { args: ["doctor","scan-health"] }  → full health sweep
```

### 🆕 WHEN creating a new file
```
projectmind_scan_project { root: "." }  → register it in the knowledge graph
projectmind_get_context { filePath }    → find similar patterns to follow
```

### 🔄 WHEN refactoring
```
projectmind_refactor_roi { target: "<file>" }  → check ROI before investing effort
projectmind_structural_search { nodeKind, namePattern }  → find all occurrences
```

### 💾 MEMORY — use across sessions
```
projectmind_store_memory { scope:"decisions", key:"<topic>", value:"<what+why>" }
projectmind_get_memory { scope:"decisions" }
```
Store architectural decisions, API contracts, config choices. Retrieve them when
returning to a file you haven't touched recently.

---

## TOOL PREFERENCE ORDER

1. Dedicated tool (e.g., `projectmind_check_coherence`, `projectmind_debt_report`) — typed, structured
2. `projectmind_run_cli` bridge — for CLI commands without a dedicated tool
3. Never guess about codebase state — always query first

## KEY RULES

- **NEVER edit a file blind.** Always `projectmind_get_context` first.
- **ALWAYS run coherence check after edits.** Fix warnings immediately.
- **Treat debt_items severity=high as blockers.** Resolve before proceeding.
- **Store decisions in memory.** Future sessions will thank you.
- **When in doubt, ask the graph:** `projectmind_trace_imports`,
  `projectmind_get_dependents`, `projectmind_find_circular_deps`,
  `projectmind_structural_search` — they know more than you do.

## QUICK REFERENCE

| Task | Tool |
|------|------|
| File context | `projectmind_get_context { filePath }` |
| Impact analysis | `projectmind_analyze_impact { filePath }` |
| Quality check | `projectmind_check_coherence { code, filePath }` |
| Debt report | `projectmind_debt_report { resolveAfter: false }` |
| Health score | `projectmind_genome_score {}` |
| Circular deps | `projectmind_find_circular_deps {}` |
| Find duplicates | `projectmind_run_cli { args: ["dedup"] }` |
| Git churn | `projectmind_run_cli { args: ["churn","--since","30"] }` |
| Security audit | `projectmind_run_cli { args: ["audit"] }` |
| SBOM | `projectmind_run_cli { args: ["sbom"] }` |
| Test scaffolding | `projectmind_run_cli { args: ["testgen","src/foo.ts"] }` |
| Full CLI access | `projectmind_run_cli { args: [...] }` |

## SETUP

If ProjectMind tools are not visible:
```bash
npm install --legacy-peer-deps
npx projectmind scan
```
Then reload your MCP client session.