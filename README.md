# ProjectMind

**Living Codebase Intelligence Layer for AI Agents** — persistent memory, real-time coherence checking, and architectural guardrails.

[![CI](https://github.com/emirinnium/projectmind/workflows/CI/badge.svg)](https://github.com/emirinnium/projectmind/actions)
[![npm version](https://img.shields.io/npm/v/projectmind.svg)](https://www.npmjs.com/package/projectmind)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)

---

## What is ProjectMind?

ProjectMind gives AI coding agents (like Kilo, Cursor, Copilot) a **persistent, queryable understanding of your codebase** that survives across sessions. It acts as a "second brain" for agents:

- **🧠 Persistent Memory** — Agents store/retrieve decisions, patterns, and context across sessions
- **🔍 Real-time Coherence** — Fast pattern matching + optional LLM deep analysis on every edit
- **🏗 Architectural Guardrails** — Detect drift, circular deps, redundancy, and cognitive debt
- **📊 Codebase Intelligence** — Scale reports, hotspot detection, agent coverage heatmaps
- **🔌 MCP Server** — 38 tools exposed via Model Context Protocol for any compatible client

---

## Quick Start

### Install globally (CLI)
```bash
npm install -g projectmind
```

### Initialize in your project
```bash
cd your-project
projectmind init
```

This creates a `.projectmindrc.json` config and `.projectmind/` directory for the SQLite knowledge graph.

### Scan your codebase
```bash
projectmind scan
```

### Check coherence of a file
```bash
projectmind check src/auth.ts
```

### View project health
```bash
projectmind genome    # Coherence genome score (0-100%)
projectmind scale     # Scale report, hotspots, coverage
projectmind debt      # Cognitive debt report
```

### Run as MCP Server (for AI agents)
```bash
projectmind mcp
```

Configure your AI client (Kilo, Cursor, etc.) to connect via stdio transport.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `init` | Initialize ProjectMind in current project |
| `scan [options]` | Scan project, build/update knowledge graph |
| `check [options] <path>` | Check coherence of file(s) |
| `report` | Generate full coherence + debt report |
| `context <file>` | Get relevant context for a file (imports, dependents, patterns) |
| `session` | Manage agent sessions (start, end, list) |
| `memory [scope] [key]` | Read/write agent memory |
| `scale` | Show project scale, modules, coverage heatmap |
| `debt` | Show cognitive debt report |
| `genome` | Compute project coherence genome score |
| `resolve <id>` | Mark debt item as resolved |
| `mcp` | Start ProjectMind as MCP server (stdio) |
| `health` | System health check |
| `debug` | Diagnostic commands |
| `doctor` | Automated fixes & remediation |
| `agent` | Inspect agent sessions & coverage |

---

## MCP Tools (38 tools)

When running as MCP server, these tools are available to AI agents:

**Core**
- `check_coherence` — Real-time coherence check (fast/deep)
- `get_context` — File context: imports, dependents, similar files, patterns
- `store_memory` / `get_memory` — Persistent cross-session memory
- `scan_project` — Full project scan with import analysis
- `genome_score` — Project coherence genome
- `debt_report` — Cognitive debt with severity breakdown
- `scale_report` — Scale, modules, hotspots, coverage

**Import/Dependency Analysis**
- `trace_imports` — Transitive dependency tree
- `find_circular_deps` — Detect circular dependencies
- `resolve_import` — Resolve import to actual file
- `get_dependents` — Reverse dependencies (who imports this)
- `get_dependency_graph` — Module dependency graph
- `resolve_path` — TS/JS path resolution with aliases
- `find_file_by_import` — Find files matching import pattern

**Architecture & Impact**
- `check_architecture` — Validate against project patterns
- `analyze_impact` — Impact radius of a change
- `suggest_refactor` — Refactoring suggestions

**Continuous Sync**
- `register_file_watch` / `unregister_file_watch` — Watch files for changes
- `get_file_status` — Real-time file status
- `sync_context` — Push/pull agent context

---

## Configuration

Create `.projectmindrc.json` in project root:

```json
{
  "projectRoot": ".",
  "databasePath": ".projectmind/pm-knowledge.db",
  "embeddingsDir": ".projectmind/embeddings",
  "maxDepth": 10,
  "ignorePatterns": [
    "node_modules/**",
    "dist/**",
    ".git/**",
    "*.min.js",
    "*.map"
  ],
  "llm": {
    "provider": "anthropic",
    "model": "claude-3-5-sonnet-20241022",
    "apiKey": "sk-ant-...",
    "deepModel": "claude-3-opus-20240229",
    "confidenceThreshold": 0.7,
    "maxCacheSize": 10000
  },
  "features": {
    "coherenceEngine": true,
    "debtTracker": true,
    "scaleManager": true,
    "memoryBridge": true
  },
  "scanOnStartup": true
}
```

**Environment variables** (alternative to config file):
- `PROJECTMIND_ROOT` — Project root path
- `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` — LLM API key
- `OPENAI_API_KEY` — For OpenAI provider
- `OLLAMA_BASE_URL` — For local Ollama provider

---

## Architecture

```
src/
├── cli/                    # CLI commands (16 commands)
├── core/
│   ├── coherence-engine.ts    # Fast + deep coherence checking
│   ├── debt-tracker.ts        # Cognitive debt detection
│   ├── scale-manager.ts       # Scale reports, heatmaps
│   └── llm/                   # LLM providers (Anthropic, OpenAI, Ollama)
├── mcp/
│   ├── tools/                 # 38 MCP tool registrations
│   └── index.ts               # Tool registry
├── parser/
│   ├── ast-parser.ts          # Multi-language AST parsing
│   ├── pattern-extractor.ts   # Pattern detection library
│   └── embeddings.ts          # 128-dim code embeddings
├── storage/
│   ├── database.ts            # SQLite (better-sqlite3)
│   ├── kg/                    # Knowledge graph (modular)
│   └── schema.ts              # SQL schema
└── utils/config.ts            # Configuration loader
```

---

## How It Works

1. **Scan** — `projectmind scan` parses all source files, extracts AST, functions, classes, imports, embeddings
2. **Store** — Knowledge persisted in SQLite (`.projectmind/pm-knowledge.db`)
3. **Analyze** — Coherence engine checks patterns (fast) or calls LLM (deep)
4. **Track** — Debt tracker computes genome score, finds redundancy/drift/circular deps
5. **Serve** — MCP server exposes 38 tools for AI agents to query in real-time

---

## Requirements

- **Node.js ≥ 22** (ESM, `sqlite3` native bindings)
- **npm ≥ 10**

---

## Development

```bash
# Clone
git clone https://github.com/emirinnium/projectmind.git
cd projectmind

# Install
npm install

# Build
npm run build

# Test
npm test

# Dev CLI
npm run dev -- scan

# Start MCP server
npm run start:mcp
```

---

## License

MIT © [emirinnium](https://github.com/emirinnium)

---

## Links

- **Repository**: https://github.com/emirinnium/projectmind
- **Issues**: https://github.com/emirinnium/projectmind/issues
- **NPM**: https://www.npmjs.com/package/projectmind