# ProjectMind v0.9.0 Roadmap

## Vision

ProjectMind evolves from "Claude Code + smart project memory" into "Claude Code + project brain" — a persistent, intelligent knowledge layer that enables predictive analysis, cross-project learning, and multi-agent coordination.

## Prioritized Features (v0.9.0)

### 1. 🧠 Intent-Driven Semantic Navigation (Hybrid RAG)
- **Goal**: Enable agents to find code by intent, not just keywords or embedding similarity
- **Key innovation**: Structural + Semantic + Intent triple search combining AST analysis, knowledge graph traversal, and natural language intent classification
- **Impact**: Agents can find "auth-related code" even when the word "auth" doesn't appear, by following structural paths and intent classifiers
- **Status**: ⏳ Planned for M3 phase

### 2. 🔮 Predictive Impact Analysis (Change Prediction Beforehand)
- **Goal**: Predict which tests and files will break before a change is made
- **Key innovation**: AST diff simulation + historical failure correlation to proactively identify ripple effects
- **Impact**: Reduces the "test breakage cycle" from 3-5 iterations to near-zero; developers know the impact before writing code
- **Status**: ⏳ Planned for M3 phase

### 3. 🎭 Agent Coding Personality & Skill Persistence
- **Goal**: Maintain agent coding style across sessions using fingerprint-based profiles
- **Key innovation**: Fingerprint extraction from AST (async preference, type strictness, error handling style, naming conventions, test patterns) stored in knowledge graph
- **Impact**: Same agent produces consistent code across 10+ sessions; team-wide style homogeneity improves
- **Status**: ⏳ Planned for M3 phase

### 4. ⚡ Context Window Budget Optimizer (Token-Aware File Ranking)
- **Goal**: Maximize relevance within token budgets using knapsack optimization
- **Key innovation**: Multi-factor relevance scoring (semantic + structural + recency) + knapsack solver to select optimal file subset
- **Impact**: Token waste reduced; agents get "this task needs 12 files totaling 95k tokens" transparency instead of guessing
- **Status**: ⏳ Planned for M3 phase

### 5. 🌐 Cross-Project Pattern Learning
- **Goal**: Learn patterns from one project and apply them in another
- **Key innovation**: Abstract pattern extraction from AST, embedding-based similarity, and cross-project success metrics
- **Impact**: "I've seen this repository pattern in 3 other microservices; it should adapt well" — reduces reinvention
- **Status**: ⏳ Planned for M3 phase

### 6. 🛡️ Self-Healing Knowledge Graph (Stale Data Auto-Repair)
- **Goal**: KG automatically stays consistent when files move, rename, or delete
- **Key innovation**: Scheduled integrity checks + git log --follow for rename detection + orphan node flagging
- **Impact**: "File not found" errors eliminated; agent never wastes time searching for stale KG entries
- **Status**: ⏳ Planned for M3 phase

### 7. 🎯 Context Window Budget Optimizer (Token-Aware File Ranking)
- **Goal**: Maximize relevance within token budgets using knapsack optimization
- **Key innovation**: Multi-factor relevance scoring (semantic + structural + recency) + knapsack solver to select optimal file subset
- **Impact**: Token waste reduced; agents get explicit budget accounting
- **Status**: ⏳ Planned for M3 phase

## Phase Allocation (M3 = 3 months)

| Phase | Feature | Primary Benefit |
|-------|---------|----------------|
| Phase 9 | Intent-Driven Search Engine | Find code by intent, not just keywords |
| Phase 10 | Predictive Impact Analyzer | Know test breakage before committing |
| Phase 11 | Agent Fingerprint & Profile Persistence | Consistent coding style across sessions |
| Phase 12 | Real-Time Collaborative Context | Multi-agent semantic coordination |
| Phase 13 | Self-Healing KG | Eliminate stale data errors |
| Phase 14 | Context Window Budget Optimizer | Token-efficient file selection |

## Quick Wins (First 2 weeks of M3)

1. **Fingerprint extraction** — AST-based style profiling ( easiest to implement, immediate value)
2. **Intent classifier** — Zero-shot task type classification (bug fix / feature / refactor / test)
3. **KG integrity guard** — Scheduled stale-detection scan (highest reliability impact)

## Low-Risk Feature Candidates (Post-v0.9.0)

These features have lower immediate impact but provide valuable extensions:

- **📊 API Surface Monitor**: Track and report on API endpoint changes across releases
- **🏷️ Tag-based File Organization**: Enable flexible file categorization beyond the existing module structure
- **📅 Change Prediction Timeline**: Estimate when refactoring efforts will yield measurable genome score improvements
- **🔔 Notification Subsystem**: Low-priority push notifications for significant KG changes (new agents, major refactors)

## Success Metrics for v0.9.0

- ✅ Genome score ≥ 70% (up from current ~55%)
- ✅ Zero high-severity debt items
- ✅ Circular dependency count = 0 in core modules
- ✅ Agents report "context was relevant" at ≥ 80% satisfaction
- ✅ Token usage reduced ≥ 25% per task via budget optimization

### Debt Budget Allocation

| Category | Budget | Rationale |
|----------|--------|-----------|
| Cognitive load reduction | 30% | Address high-load files (>0.7 threshold) that impact genome score |
| Redundancy cleanup | 25% | Remove duplicate code detected by redundancy detector |
| Circular dependency resolution | 20% | Break inter-module cycles in core packages |
| Pattern drift prevention | 15% | Maintain architectural consistency across codebase |
| Code age remediation | 10% | Review and update legacy files exceeding 365-day threshold |