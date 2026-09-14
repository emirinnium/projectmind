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
pm doctor install               # Diagnose Node/npm/config/provider installation
pm doctor install --root <path> # Diagnose another project root without changing cwd
pm mcp-init codex --verify      # Verify MCP entry without changing config
pm mcp-init opencode --verify --handshake  # Verify config plus a live stdio handshake
pm health --json               # Machine-readable health summary
pm audit --all                 # Production-code security audit
pm audit --all --include-tests # Include test/spec fixtures explicitly
```

The core install does not require native embedding runtimes. If transformer
embeddings or local UniXcoder/CodeBERT models are needed, install those
optional peer providers explicitly in the same scope as ProjectMind:

```bash
npm install @huggingface/transformers onnxruntime-node
```

Without them, ProjectMind remains fully usable with its deterministic `simple`
embedding provider; `pm doctor install` reports the provider state.

For optional deep LLM analysis through OpenRouter, set
`llm.provider` to `"openrouter"`, choose an OpenRouter model ID, and provide
`OPENROUTER_API_KEY`. ProjectMind only accepts OpenRouter's official HTTPS
endpoint (`https://openrouter.ai/api/v1`) and never reads OpenCode credentials
automatically.

Run `pm --help` for the complete command tree. JSON output is available on
commands that support automation and CI workflows.

### GitHub Action

The repository ships a bounded cross-platform composite action for CI:

```yaml
- uses: emirinnium/projectmind/.github/actions/projectmind@master
  with:
    command: audit
    version: 1.0.4
    report-path: projectmind-audit.json
```

`command` is allowlisted (`health`, `audit`, or `pr-preview`), the version is
pinned, and the report path is workspace-relative. It does not execute
arbitrary shell input or require a global installation.

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

For parallel agent work, the `arbitrate_agents` MCP tool combines advisory
locks, graph-aware collision risk, dependency order, conflict groups, and
isolated-file shard suggestions before edits begin. It never changes source or
git state; its default ledger entry stores hashes and bounded summary metadata.

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

Evidence and agent memory surfaces are explicit and reproducible:

```bash
# Record a payload-free decision and verify the local hash chain
pm ledger record --event-type review --tool review_project --input-json '{"base":"HEAD^","head":"HEAD"}' --result-json '{"findings":0}' --format json
pm ledger verify --format json
# Export the hashes for independent CI/audit verification
pm ledger export --format json > ledger-export.json
pm ledger verify --export ledger-export.json --format json
# Create a validated SQLite snapshot; restore requires explicit confirmation
pm ledger backup --output .projectmind/pm-knowledge.db.backup --format json
pm ledger restore --input .projectmind/pm-knowledge.db.backup --force --format json

# See how much context was selected and what was excluded
pm budget --task "fix authentication" --budget 6000 --input-price-per-1k 0.15 --format json

# Personalize safe mechanical fixes only after evidence accumulates
pm autofix recommend --minimum-samples 3
pm autofix record var-to-const --feedback accepted --agent my-agent
```

For repeatable local cost estimates, an optional `llm.pricing` record in the
global or project config can include `inputPricePer1k`, `source`,
`effectiveAt`, and `expiresAt`. Direct `--input-price-per-1k` overrides it;
expired or future-dated records are excluded from cost arithmetic.

Auto-Fix recommendations are conservative: skipped outcomes do not count as
acceptance, mixed or small samples remain inconclusive, and `pm autofix
opt-out`/`reset` provide project-scoped privacy and control. `pm risk calibrate
<file>` scores a labeled JSON corpus with Brier score; it does not invent a
calibration claim when no historical labels are supplied.

## Project boundary and configuration

- `.pmignore` is the single source of truth for files ProjectMind must not read.
- `.projectmindrc.json` contains runtime settings such as the database path,
  embeddings, limits, and feature flags; it is not an ignore file.
- ProjectMind automatically excludes generated, dependency, cache, and VCS
  directories in addition to `.pmignore` rules.

When the database is shared by linked checkouts, ProjectMind automatically
selects a stable graph namespace for the current Git branch and worktree. A
new commit on the same branch keeps its namespace and is marked stale until a
fresh scan; another branch or worktree gets a separate project namespace. Use
`pm project current` to inspect the active namespace and `pm project worktrees`
to list or prune stale namespaces. Non-Git folders continue to use the normal
project selection behavior.

Run `pm init` in a project to create missing `.pmignore`, a sparse
`.projectmindrc.json`, and the project-local `.mcp.json` without overwriting
existing files. Use `pm init --root <path>` when initializing a directory other
than the current one. Runtime configuration precedence is:
`defaults < global config < project config < environment < CLI overrides`.
The global config is stored at `%APPDATA%/projectmind/config.json` on Windows,
`$XDG_CONFIG_HOME/projectmind/config.json` when configured, or
`~/.config/projectmind/config.json` on Linux/macOS; project settings override
matching global settings. Keep credentials in environment variables or the
global config, not in a tracked project file.

Manage the layers without hand-editing paths:

```bash
pm config init --global       # create a sparse user-level config once
pm config show --effective    # inspect the merged config (secrets redacted)
pm config set --global llm.model '"your-model"'
pm config path --project
```

`pm config set` accepts only schema-backed keys and validates the value before
writing. Existing files are never overwritten by `config init`; use the
project file for intentional, reviewable overrides.

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
