# Low Debt Analysis

Snapshot: 2026-09-09 (live database report)

This document records the current low-severity findings after the latest debt
detection run. Low findings are intentionally not auto-resolved: a detector
candidate is not, by itself, proof that two implementations should be merged
or that a frequently changed file is defective.

## Current summary

- Open low findings: **16**
- Redundancy candidates: **9**
- Change-frequency signals: **7**
- Medium findings: **0**
- High findings: **0**
- Coherence genome score: **97.61%**

The previous 2026-09-07 snapshot reported 487 embedding candidates. That
snapshot is superseded. The current detector uses the stricter AST clone
fingerprint for redundancy and no longer treats broad embedding similarity as
an actionable debt item.

## File-by-file findings

### Change-frequency signals

These are historical risk indicators, not defects. Each file had the following
number of commits in the last 30 days:

- `src/cli/commands/doctor.ts` — 10 commits
- `src/cli/program.ts` — 10 commits
- `src/mcp-server.ts` — 16 commits
- `src/mcp/tools/registry/index.ts` — 11 commits
- `src/mcp/tools/sync.ts` — 10 commits
- `src/storage/kg/graph.ts` — 11 commits
- `src/storage/kg/helpers/files.ts` — 10 commits

Recommended action is targeted regression review when these files change. No
source refactor is justified solely by commit frequency.

### Redundancy candidates

These nine findings are AST Type-2 clone matches. Each has a concrete code
location and fingerprint, but each still needs semantic review before an
extraction. The current status is “review candidate”, not “confirmed defect”.

- `src/core/coherence/analysis/deep.ts:250-293` (`storeDecision`) and
  `src/core/coherence/analysis/fast.ts:166-209` (`storeDecision`)
- `src/cli/commands/refs.ts:97-109` (`describeSpan`) and
  `src/mcp/tools/symbol-def.ts:160-172` (`defineDescribeSpan`)
- `src/cli/commands/refs.ts:97-109` (`describeSpan`) and
  `src/mcp/tools/symbol-refs.ts:69-81` (`describeSpan`)
- `src/cli/commands/graph-feature-map.ts:76-89` (`inheritGraphOptions`) and
  `src/cli/commands/graph.ts:340-356` (`inheritGraphOptions`)
- `src/core/watcher.ts:25-32` (`isMissingPathError`) and
  `src/storage/kg/knowledge-graph-base.ts:68-75` (`isMissingPathError`)
- `src/cli/commands/refs.ts:84-95` (`pickDeclarationPosition`) and
  `src/mcp/tools/symbol-refs.ts:54-65` (`pickDeclarationPosition`)
- `src/core/snapshots/graph-snapshot-diff.ts:21-32` (`callSortKey`) and
  `src/core/snapshots/graph-snapshot-diff.ts:70-81` (`callSignature`)
- `src/core/team-memory/merge.ts:184-190` (`linesEqual`) and
  `src/storage/kg/helpers/imports.ts:133-139` (`cyclesEqual`)
- `src/storage/repositories/project-repository.ts:28-33` (`getById`) and
  `src/storage/repositories/project-repository.ts:35-40` (`getByName`)

The likely safe follow-up candidates are the shared `storeDecision` logic and
the symbol-position helpers. The remaining matches are either intentionally
symmetrical repository queries, tiny generic comparisons, or APIs with
different ownership boundaries. They remain low-priority until a common
abstraction can be introduced without coupling CLI, MCP, and storage layers.

## Decision

No low finding was deleted or marked resolved to improve the score. No source
code was changed as a result of the low findings in this snapshot. Medium and
high debt are both zero; future work should promote a low item only when code
review confirms duplicated business behavior, a measurable regression risk, or
a missing safeguard.
