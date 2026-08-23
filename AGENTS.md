# AGENTS.md — ProjectMind Codebase Intelligence Rules

## Overview

You have access to ProjectMind MCP tools for persistent codebase intelligence.
These tools give you a live knowledge graph of the entire project: file relationships,
import chains, technical debt, coherence analysis, and cross-session memory.

**Use them proactively. Do not wait to be asked.**

---

## MANDATORY WORKFLOWS

### 🔍 BEFORE touching any file
```
get_context { filePath }     → understand imports, dependents, structure
analyze_impact { filePath }  → know who breaks if you change this
```

### ✏️ AFTER every file edit/save
```
check_coherence { code, filePath, fastOnly: true }   → instant quality gate
```
If verdict is "warn" or "fail": read `suggestions`, fix before moving on.

### 📝 BEFORE proposing any commit
```
debt_report {}                    → check high-severity debt = 0
find_circular_deps {}             → verify no new cycles
genome_score {}                   → confirm score ≥ 70%
run_cli { args: ["doctor","scan-health"] }  → full health sweep
```

### 🆕 WHEN creating a new file
```
scan_project { root: "." }        → register it in the knowledge graph
get_context { filePath }          → find similar patterns to follow
```

### 🔄 WHEN refactoring
```
refactor_roi { target: "<file>" } → check ROI before investing effort
structural_search { nodeKind, namePattern }  → find all occurrences
```

### 💾 MEMORY — use across sessions
```
store_memory { scope:"decisions", key:"<topic>", value:"<what+why>" }
get_memory { scope:"decisions" }
```
Store architectural decisions, API contracts, config choices. Retrieve them when
returning to a file you haven't touched recently.

---

## TOOL PREFERENCE ORDER

1. Dedicated tool (e.g., `check_coherence`, `debt_report`) — typed, structured
2. `run_cli` bridge — for CLI commands without a dedicated tool
3. Never guess about codebase state — always query first

## KEY RULES

- **NEVER edit a file blind.** Always `get_context` first.
- **ALWAYS run coherence check after edits.** Fix warnings immediately.
- **Treat debt_items severity=high as blockers.** Resolve before proceeding.
- **Store decisions in memory.** Future sessions will thank you.
- **When in doubt, ask the graph:** `trace_imports`, `get_dependents`,
  `find_circular_deps`, `structural_search` — they know more than you do.

## QUICK REFERENCE

| Task | Tool |
|------|------|
| File context | `get_context { filePath }` |
| Impact analysis | `analyze_impact { filePath }` |
| Quality check | `check_coherence { code, filePath }` |
| Debt report | `debt_report { resolveAfter: false }` |
| Health score | `genome_score {}` |
| Circular deps | `find_circular_deps {}` |
| Find duplicates | `run_cli { args: ["dedup"] }` |
| Git churn | `run_cli { args: ["churn","--since","30"] }` |
| Security audit | `run_cli { args: ["audit"] }` |
| SBOM | `run_cli { args: ["sbom"] }` |
| Test scaffolding | `run_cli { args: ["testgen","src/foo.ts"] }` |
| Full CLI access | `run_cli { args: [...] }` |

## SETUP

If ProjectMind tools are not visible:
```bash
npm install --legacy-peer-deps
npx projectmind scan
```
Then reload your MCP client session.
