---
name: projectmind
description: Living Codebase Intelligence Layer - persistent memory, real-time coherence, architectural guardrails
version: 1.0.0
author: ProjectMind Team
---

# ProjectMind Skill for Kilo

This skill teaches Kilo agent to **continuously** leverage ProjectMind's 30+ MCP tools for:
- Real-time coherence checking
- Persistent cross-session memory
- Architectural impact analysis
- Cognitive debt tracking
- Dependency graph intelligence

## Core Workflows

### Workflow 1: Session Bootstrap (`pm-bootstrap`)
**Trigger**: Session start (auto via instructions)
**Tools**: `start_session` → `scan_project` → `genome_score` → `debt_report` → `store_memory`
**Output**: Baseline health metrics

### Workflow 2: Edit-Time Guardrails (`pm-guard`)
**Trigger**: Every file edit
**Tools**: `get_context` → `check_architecture` → `check_coherence(fast)` → `sync_context(push)`
**Output**: Violation warnings or pass confirmation

### Workflow 3: Pre-Commit Gate (`pm-gate`)
**Trigger**: Before commit/PR/feature complete
**Tools**: `genome_score` → `debt_report(resolveAfter:true)` → `find_circular_deps` → `analyze_impact`
**Output**: Pass/Fail with regression details

### Workflow 4: Bug Investigation (`pm-investigate`)
**Trigger**: User reports error/bug
**Tools**: `trace_imports` → `get_dependents` → `analyze_impact` → `get_context` → `suggest_refactor`
**Output**: Root cause + fix suggestions + impact radius

### Workflow 5: Refactor Planning (`pm-refactor`)
**Trigger**: User wants to refactor/redesign
**Tools**: `get_dependency_graph` → `find_file_by_import` → `suggest_refactor(all)` → `check_architecture`
**Output**: Refactor plan with risk assessment

### Workflow 6: New Feature Scaffold (`pm-scaffold`)
**Trigger**: User starts new feature/module
**Tools**: `find_file_by_import` (pattern discovery) → `check_architecture` (layer validation) → `get_context` (similar files)
**Output**: Recommended structure, patterns, imports

## Agent Persona Modifications

When this skill is active, the agent:

1. **Speaks in metrics**: "Genome dropped from 78% → 72% due to new circular dep"
2. **Cites evidence**: "Coherence check on auth.ts: verdict=violation, reason=mixed async patterns"
3. **Proposes fixes**: "Suggest extracting common error handler (see debt item #42)"
4. **Remembers context**: "Per session memory, we decided to use Repository pattern for data layer"

## Tool Aliases (Mental Shortcuts)

| Short Name | MCP Tool |
|------------|----------|
| `pm-scan` | `projectmind_scan_project` |
| `pm-check` | `projectmind_check_coherence` |
| `pm-arch` | `projectmind_check_architecture` |
| `pm-impact` | `projectmind_analyze_impact` |
| `pm-debt` | `projectmind_debt_report` |
| `pm-genome` | `projectmind_genome_score` |
| `pm-context` | `projectmind_get_context` |
| `pm-deps` | `projectmind_get_dependency_graph` |
| `pm-memory` | `projectmind_store_memory` / `get_memory` |
| `pm-sync` | `projectmind_sync_context` |
| `pm-refactor` | `projectmind_suggest_refactor` |

## Configuration

Skill respects `.projectmindrc.json` for:
- LLM provider (deep analysis)
- Ignore patterns
- Feature flags

No additional config needed.