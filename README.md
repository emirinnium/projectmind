# ProjectMind

Living codebase intelligence for JavaScript and TypeScript projects.

```text
  ____            _           _   __  __ _           _
 |  _ \ _ __ ___ (_) ___  ___| |_|  \/  (_)_ __   __| |
 | |_) | '__/ _ \| |/ _ \/ __| __| |\/| | | '_ \ / _` |
 |  __/| | | (_) | |  __/ (__| |_| |  | | | | | | (_| |
 |_|   |_|  \___// |\___| \___|\__|_|  |_|_|_| |_|\__,_|
                |__/
```

[![npm](https://img.shields.io/npm/v/@emirhanturker/projectmind)](https://www.npmjs.com/package/@emirhanturker/projectmind)
[![GitHub](https://img.shields.io/github/stars/emirinnium/projectmind?style=flat)](https://github.com/emirinnium/projectmind)

ProjectMind builds a persistent knowledge graph of a project so coding agents can
understand imports, dependents, architectural coherence, cognitive debt, data
flows, and project history. It provides both a cross-platform CLI and an MCP
server. The supported analysis surface is intentionally focused on JavaScript
and TypeScript (`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`).

## Install

```bash
npm install --global @emirhanturker/projectmind
cd your-project
pm scan
pm health
```

The `projectmind` and `pm` commands are equivalent. ProjectMind requires Node.js
22.13 or newer and does not require `--legacy-peer-deps`.

## Quick start

```bash
pm scan                         # Build or refresh the knowledge graph
pm context src/index.ts         # Assemble context for a file
pm impact src/index.ts          # Analyze change impact
pm check src/index.ts           # Run a coherence check
pm genome                      # Project coherence score
pm debt                        # Cognitive debt report
pm find-circular-deps          # Cycle detection
pm graph feature-map --format json # Explain feature candidates and import flows
pm graph snapshot               # Save a reproducible graph snapshot
pm proof verify --format json   # Verify source hashes before trusting analysis
pm proof claim "claim" --files src/index.ts # Keep claim evidence explicit
pm pr-preview --format sarif    # Export CI/code-scanning review findings
pm review --policy .projectmind/review-policy.json # Deterministic policy + reflected findings
pm range src/index.ts --start 0 --end 512 --format json # Byte-bounded source retrieval
pm benchmark prepare            # Create a metadata-first golden fixture manifest
pm benchmark search -q "auth token" # Measure deterministic lexical retrieval
pm benchmark review --base main --head HEAD # Measure review coverage/evidence
pm doctor install               # Diagnose Node/npm/config/provider installation
pm mcp-init codex --verify      # Verify MCP entry without changing config
pm health --json               # Machine-readable health summary
pm audit --all                 # Production-code security audit
pm audit --all --include-tests # Include test/spec fixtures explicitly
```

Run `pm --help` for the complete command tree. JSON output is available on
commands that support automation and CI workflows.

## Evidence-first analysis

Analysis results are intentionally distinguishable from proof. `pm proof verify`
compares current source hashes with the indexed graph and reports every file as
fresh, stale, unindexed, missing, or unknown. `pm proof claim` requires explicit
source paths and reports source-backed freshness only; it does not pretend that
a natural-language claim, similarity score, or fresh hash is AST, typecheck, or
runtime proof. Use `pm graph snapshot` plus `pm graph verify` to detect graph
drift, and `pm pr-preview --format sarif` to feed deterministic findings into
CI code-scanning consumers.

## MCP setup

Generate a project-local MCP configuration and agent instructions for the
client you use:

```bash
pm mcp-init codex
pm mcp-init claude-code
pm mcp-init opencode
pm mcp-init devin
pm mcp-init antigravity
pm mcp-init kilo-code
```

The generated server uses the published package through `npx`, pins
`PROJECTMIND_ROOT` to the project, and preserves unrelated client settings.
Re-running the command is idempotent; `--force` refreshes only a generated
ProjectMind block and never replaces a user's complete instruction file.
See [`docs/MCP.md`](docs/MCP.md) for client-specific details and the complete
core MCP surface (plus resource-subscription tools). Use `pm mcp --profile
core|review|security|maintenance|full` to control discovery breadth.

## Deterministic review and retrieval

Review output is generated from a versioned `.projectmind/review-policy.json`
when present. Changed files are sorted and split into source-hashed bundles;
line positions and rule evidence are independently reflected before SARIF or
PR output is published. `get_source_range`/`pm range` returns only a bounded
UTF-8 byte range with line coordinates and a source hash, which helps agents
reduce context payload without treating truncation as complete coverage. See
[`docs/BENCHMARK.md`](docs/BENCHMARK.md) and
[`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md). Optional graph/vector
adapter boundaries are documented in [`docs/BACKENDS.md`](docs/BACKENDS.md);
SQLite remains the default and no remote service is required.

## Project boundary and configuration

- `.pmignore` is the single source of truth for files ProjectMind must not read.
- `.projectmindrc.json` contains runtime settings such as the database path,
  embeddings, limits, and feature flags; it is not an ignore file.
- ProjectMind automatically excludes generated, dependency, cache, and VCS
  directories in addition to `.pmignore` rules.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

## Links

- [npm package](https://www.npmjs.com/package/@emirhanturker/projectmind)
- [GitHub repository](https://github.com/emirinnium/projectmind)
- [Security policy](SECURITY.md)
- [Dependency and publisher decisions](docs/DEPENDENCY-DECISIONS.md)
- [Contributing guide](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License

MIT — see [`LICENSE`](LICENSE).
