---
description: Initialize ProjectMind knowledge graph and start agent session
agent: code
model: kilo/anthropic/claude-sonnet-4
subtask: true
hidden: true
---
# ProjectMind Auto-Initialization

This command runs automatically at session start via Kilo's instruction system.

## Instructions for Agent

**IMMEDIATELY on session start, execute these steps in order:**

### Step 1: Start ProjectMind Session
```tool
projectmind_start_session
{"agentName": "kilo-code"}
```

### Step 2: Scan Project (if knowledge graph is empty/stale)
```tool
projectmind_scan_project
{"root": "${workspaceFolder}", "analyzeImports": true, "findCircularDeps": true}
```

### Step 3: Get Baseline Metrics
```tool
projectmind_genome_score
{}
```

```tool
projectmind_debt_report
{"resolveAfter": true}
```

### Step 4: Store Session Context
```tool
projectmind_store_memory
{"scope": "session", "key": "initialized", "value": "{\"timestamp\": \"${ISO_DATE}\", \"workspace\": \"${workspaceFolder}\"}", "sessionId": ${SESSION_ID}}
```

## Agent Behavior Rules

1. **ALWAYS** run this at session start (Kilo instructions will trigger it)
2. If scan takes >10s, report progress but continue
3. Store `sessionId` from step 1 for all subsequent calls
4. If genome score < 0.6, warn user: "⚠️ Project coherence low (${score}%). Consider refactoring."
5. If high-severity debt > 0, list top 3 items immediately

## Output Format

Return a concise summary:
```
✅ ProjectMind initialized
📊 Genome: ${score}% (${status})
🔴 High debt: ${count} | 🟡 Medium: ${count} | 🟢 Low: ${count}
🔍 Circular deps: ${count}
📁 Files indexed: ${count}
```