# Changelog

All notable changes to this project will be documented in this format.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial public release preparation
- README.md with full documentation
- MIT License
- .gitignore for proper file exclusion
- GitHub Actions CI workflow (multi-Node matrix)
- NPM publish configuration with `files` field
- `.projectmindrc.example.json` template

### Changed
- Updated `package.json` with repository, bugs, homepage, publishConfig
- Added `prepare` script for automatic build on publish

## [0.1.0] - 2026-08-18

### Added
- **Core Architecture**
  - Coherence Engine (fast pattern matching + LLM deep analysis)
  - Debt Tracker (genome score, redundancy, architectural drift, pattern drift)
  - Scale Manager (project scale, modules, hotspots, coverage heatmaps)
  - Knowledge Graph (SQLite-backed, files, functions, classes, imports, embeddings)
  - Pattern Library (extraction, coherence scoring, violation detection)
  - Multi-language AST Parser (TypeScript, JavaScript)
  - Code Embeddings (128-dimensional, cosine similarity)

- **CLI (16 commands)**
  - `init`, `scan`, `check`, `report`, `context`, `session`, `memory`
  - `scale`, `debt`, `genome`, `resolve`, `mcp`, `health`, `debug`, `doctor`, `agent`

- **MCP Server (38 tools)**
  - Core: coherence, context, memory, scan, genome, debt, scale, sessions
  - Import/Dependency: trace, circular deps, resolve, dependents, graph, path resolution
  - Architecture: check, impact analysis, refactor suggestions
  - Continuous Sync: file watch, status, context sync

- **LLM Providers**
  - Anthropic (Claude 3.5 Sonnet, Opus)
  - OpenAI (GPT-4o, GPT-4)
  - Ollama (local models)

- **Agent Memory Bridge**
  - Cross-session persistent memory
  - Session management with decisions & fingerprints
  - Agent coverage tracking

- **Testing**
  - Integration test suite (48 tests passing)
  - Database, KG, coherence, debt, scale, embeddings, patterns, sessions, memory

### Technical Details
- TypeScript strict mode, ESM modules
- Node.js ≥ 22 required
- SQLite via `better-sqlite3` (native bindings)
- Zero-runtime-dependency core (only 4 production deps)

---

## Release Notes Template

### [x.y.z] - YYYY-MM-DD

#### Added
- New features

#### Changed
- Changes in existing functionality

#### Deprecated
- Soon-to-be removed features

#### Removed
- Removed features

#### Fixed
- Bug fixes

#### Security
- Vulnerability fixes