---
name: common-workflows
description: Reusable ProjectMind workflow patterns
---

# Common ProjectMind Workflows

## Pattern: "Before Editing Any File"

```typescript
// Agent internal monologue (not shown to user)
const context = await projectmind_get_context({ filePath: targetFile, limit: 5 });
const arch = await projectmind_check_architecture({ filePath: targetFile, strict: true });
const coherence = await projectmind_check_coherence({ 
  code: currentContent, 
  filePath: targetFile, 
  fastOnly: true 
});

if (arch.violations.length > 0 || coherence.verdict !== 'pass') {
  // Present to user before proceeding
  presentViolations(arch.violations, coherence.reasoningTrace);
  await userConfirmation();
}
```

## Pattern: "After Successful Edit"

```typescript
await projectmind_sync_context({
  agentId: "kilo-code",
  action: "push",
  context: {
    currentFile: editedFile,
    recentDecisions: [{
      file: editedFile,
      decision: decisionSummary,
      reasoning: reasoning,
      timestamp: new Date().toISOString()
    }],
    patternsUsed: detectedPatterns,
    issuesFound: []
  }
});

// Fast coherence verification
const postCheck = await projectmind_check_coherence({
  code: newContent,
  filePath: editedFile,
  fastOnly: true
});

if (postCheck.verdict !== 'pass') {
  warnUser(postCheck);
}
```

## Pattern: "Investigate Bug at Location"

```typescript
const trace = await projectmind_trace_imports({ filePath: errorFile, maxDepth: 5 });
const dependents = await projectmind_get_dependents({ filePath: errorFile });
const impact = await projectmind_analyze_impact({ 
  filePath: errorFile, 
  changeType: "modify" 
});
const suggestions = await projectmind_suggest_refactor({ 
  filePath: errorFile, 
  focus: "architecture" 
});

presentInvestigation(trace, dependents, impact, suggestions);
```

## Pattern: "Refactor with Safety"

```typescript
// 1. Baseline
const baselineGenome = await projectmind_genome_score();
const baselineDebt = await projectmind_debt_report({ resolveAfter: true });

// 2. Plan
const refactorPlan = await projectmind_suggest_refactor({ 
  filePath: targetFile, 
  focus: "all" 
});

// 3. Execute (user confirms each step)
// ... edits happen ...

// 4. Verify
const postGenome = await projectmind_genome_score();
const postDebt = await projectmind_debt_report({ resolveAfter: true });

reportDelta(baselineGenome, postGenome, baselineDebt, postDebt);
```