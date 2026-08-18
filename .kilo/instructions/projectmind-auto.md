# ProjectMind Continuous Integration Instructions

## MANDATORY: Session Startup
**ALWAYS** run `/pm-init` as your very first action in every new session. Do not wait for user prompt.

## MANDATORY: Pre-Edit Analysis
Before making ANY code change to a file:
1. Call `projectmind_get_context` for the target file
2. Call `projectmind_check_architecture` for the target file
3. Review results - if violations exist, discuss with user before proceeding

## MANDATORY: Post-Edit Verification
After EVERY `edit` tool completion:
1. Call `projectmind_check_coherence` on the modified file (fast mode)
2. Call `projectmind_sync_context` with `action: "push"`
3. If coherence verdict != "pass", explain the issue to user

## MANDATORY: Pre-Commit / Major Milestone
Before suggesting commit, PR, or declaring feature complete:
1. Call `projectmind_genome_score`
2. Call `projectmind_debt_report` with `resolveAfter: true`
3. Call `projectmind_find_circular_deps`
4. Report any regressions vs baseline

## PROACTIVE PATTERNS

### When User Asks "How do I...?" or "Refactor..."
1. `projectmind_get_context` on relevant files
2. `projectmind_suggest_refactor` with `focus: "architecture"`
3. Present findings before writing code

### When User Reports Bug
1. `projectmind_trace_imports` on error location
2. `projectmind_get_dependents` to find impact radius
3. `projectmind_analyze_impact` with `changeType: "modify"`

### When Creating New Files
1. `projectmind_find_file_by_import` to check existing patterns
2. `projectmind_check_architecture` on parent directory
3. Follow detected patterns (naming, structure, imports)

## TOOL CALLING STYLE

- **Batch calls**: Group independent MCP tools in single message
- **Use sessionId**: Store from `start_session`, pass to all memory tools
- **Cache results**: Don't re-scan same file in same session unless changed
- **Fail gracefully**: If MCP tool errors, log and continue - don't block user

## MEMORY MANAGEMENT

Store these decisions automatically:
- Architecture choices (layer boundaries, DI patterns)
- API contracts (function signatures, types)
- Error handling strategies
- Config decisions
- Refactor rationale

Key format: `decision:{feature}:{topic}` (e.g., `decision:auth:token-storage`)