---
description: Sync current file changes to ProjectMind knowledge graph
agent: code
model: kilo/anthropic/claude-sonnet-4
subtask: true
hidden: true
---
# ProjectMind Incremental Sync

Run this **after every significant edit** (file save, refactor, new feature).

## Instructions for Agent

### Trigger Conditions (Auto-detect)
- After `edit` tool completes on any `.ts/.js/.tsx/.jsx` file
- After `bash` command that modifies source (build, generate, etc.)
- User explicitly says "sync" or "pm sync"

### Sync Steps

```tool
projectmind_sync_context
{"agentId": "kilo-code", "action": "push", "context": {"currentFile": "${CURRENT_FILE}", "patternsUsed": ["${DETECTED_PATTERNS}"], "recentDecisions": [{"file": "${CURRENT_FILE}", "decision": "${DECISION}", "reasoning": "${REASONING}", "timestamp": "${ISO_DATE}"}], "issuesFound": []}}
```

### File Watch Registration (First time only)
```tool
projectmind_file_watch
{"filePath": "${CURRENT_FILE}", "agentId": "kilo-code", "events": ["change", "coherence", "imports"]}
```

## Agent Rules

1. **Debounce**: Batch sync calls within 2 seconds
2. **Smart filtering**: Only sync if file is in `src/`, `lib/`, `app/` (not tests, config, docs)
3. **Coherence check**: After sync, run fast coherence on changed file:
   ```tool
   projectmind_check_coherence
   {"code": "${FILE_CONTENT}", "filePath": "${CURRENT_FILE}", "deep": false}
   ```
4. If verdict == "violation", immediately notify user with reasoning