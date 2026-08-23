# ProjectMind — Claude Code Instructions

## Your ProjectMind MCP Tools

You have access to a live knowledge graph of this codebase via ProjectMind.
Use these tools PROACTIVELY. They are not optional — they are your eyes into
the project's architecture, dependencies, debt, and history.

## Workflow Rules (follow these on EVERY task)

### 1. Before reading or editing any file
```
get_context { filePath }     → imports, dependents, structure, patterns
analyze_impact { filePath }  → blast radius of changes
```

### 2. After every edit you make
```
check_coherence { code: <new content>, filePath: <path>, fastOnly: true }
```
If verdict = warn/fail → read suggestions and fix before your next step.

### 3. Before suggesting or making a commit
```
debt_report {}               → high-severity items must be 0
find_circular_deps {}        → no new cycles
genome_score {}              → overall health check
run_cli { args: ["doctor","scan-health"] }  → comprehensive sweep
```

### 4. When creating new files
```
scan_project { root: "." }   → register in the knowledge graph
```

### 5. Cross-session memory
Store important decisions:
```
store_memory { scope: "decisions", key: "<topic>", value: "<decision+reason>" }
```
Retrieve when revisiting:
```
get_memory { scope: "decisions" }
```

### 6. Full CLI access
For anything without a dedicated tool:
```
run_cli { args: ["<cli-command>", ...flags] }
```
Examples: `["doctor","scan-health"]`, `["churn","--since","30"]`,
`["audit"]`, `["sbom"]`, `["testgen","src/module.ts"]`

## Golden Rules
- NEVER guess about codebase state — always query the graph first
- ALWAYS coherence-check after edits — warnings are blockers
- HIGH severity debt items are release blockers
- Store decisions — the next session needs them
- Use structural_search for precise AST-level pattern matching
