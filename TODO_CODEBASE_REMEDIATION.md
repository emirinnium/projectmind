# ProjectMind Codebase Remediation TODO

This is the tracked remediation list from the deep static review and the comparison with Zod, OpenCodeReview, and Code-Graph-RAG. Items are ordered by risk. Each item must be closed with a code change, documentation change, or an explicit architectural decision; no item is intentionally deferred.

## P0 — security and protocol correctness

- [x] Remove `stdout`/`stderr` from web API error responses; log diagnostics server-side and return a safe public error shape.
- [x] Make CLI `--json` modes emit JSON only; keep human-readable progress on stderr or suppress it.
- [x] Replace fragile `stdout.indexOf('{')` parsing with a shared CLI JSON object adapter.
- [x] Make web CLI/root discovery independent of the caller's current working directory; support Windows, Linux, packaged, and CI layouts.
- [x] Enforce embedding dimension compatibility with a deterministic rebuild or hard failure, never warning-only corruption.
- [x] Add runtime validation for web CLI responses; MCP/VS Code payload validation remains covered by existing protocol guards.
- [x] Fix the dashboard scan button's empty JSX handler and connect it to the scan workflow.

## P1 — correctness, portability, and architecture

- [x] Centralize path canonicalization and file identity (separator, drive letter, UNC, case policy).
- [x] Audit import resolution and file matching for Linux case-sensitive versus Windows case-insensitive behavior.
- [x] Make LLM rate limiting concurrency-safe with a per-provider promise queue.
- [x] Reduce direct `process.exit()` calls in validation/gate commands to exit-code assignment; preserve cleanup and embeddability. Daemon lifecycle exits remain intentionally scoped to serve/watch.
- [x] Replace production-boundary `any` types with schemas, `unknown`, and type guards.
- [x] Consolidate duplicated web CLI execution/report parsing code.
- [x] Add explicit output protocol/version fields to machine-readable CLI responses.
- [x] Validate CLI output/input/config path arguments consistently at the root CLI boundary, including traversal and foreign-platform paths.

## P1 — product completeness

- [x] Expose cgr/pprof trace converter limitations consistently in CLI, README, and command docs; native converters remain intentionally unsupported.
- [x] Provide a diff-first `review` entrypoint via the existing PR impact engine; requirements-aware LLM findings and line-level synthesis remain open.
- [x] Add deterministic line-level review rules and per-file pattern matching for dangerous eval, possible secrets, TODO/HACK markers, explicit any, and console output.
- [x] Add multi-reviewer/consensus orchestration without duplicating findings.
- [x] Add CI/GitHub Actions quality-gate integration and machine-readable annotations, including a dedicated web typecheck/build job.
- [x] Add review history, finding lifecycle, and re-review-after-fix workflow.
- [x] Add pluggable language/parser registration and capability metadata; registry and `parser-capabilities` contract are now centralized.
- [x] Extend graph schema and data-flow edges for consistent cross-language representation; data-flow records now retain source/target language metadata and project-scoped function resolution.
- [x] Add monorepo/workspace project isolation and graph query scoping; workspace discovery and project-scoped graph joins are now explicit.
- [x] Add graph export and architecture diagram workflows (existing CLI/MCP Mermaid/SVG/PNG/JSON paths audited); graph import remains open.

## P2 — maintainability and performance

- [x] Split oversized CLI commands by responsibility (doctor, autopilot, test-quality, secrets-life, sbom, refactor-roi); domain engines and the doctor fix-imports subcommand are now separate modules.
- [x] Reduce synchronous file I/O in server, MCP, watcher, and long-running scan paths; scanner/watcher and taint/path MCP reads are async, while TypeScript language-service internals remain intentionally synchronous.
- [x] Add configurable source file-size limits to parser entrypoints; streaming/chunked search remains a follow-up for very large files.
- [x] Add bounded concurrency and AbortSignal cancellation to scan and pattern extraction APIs.
- [x] Add structured logging and eliminate ad-hoc `console.log` outside the output abstraction.
- [x] Add vector-index dimension compatibility detection and deterministic rebuild. Migration rollback safety remains documented as a separate storage concern.
- [x] Mark historical `analysis-report.md` as historical and link its current remediation source/status.
- [x] Document supported Node, Linux, Windows, macOS, and deployment layouts in README.

## Verification and release gates

- [x] Restore/install dependencies and run package smoke checks.
- [x] Run root typecheck and ESLint without running tests.
- [x] Run the web production build and regenerate stale Next.js type output.
- [x] Configure Next.js workspace root and metadata base for deterministic deployment output.
- [x] Make the web API proxy opt-in so local App Router handlers are not silently bypassed.
- [x] Run platform-aware static checks for path, shell, executable, and environment handling.
- [x] Verify MCP stdio/HTTP security guards and web API redaction statically/live where safe.
- [x] Verify CLI JSON contract with strict runtime parser and live `report --json` output.
- [x] Verify no high-severity debt or dependency cycles (`debt`: 0; circular-deps: none).
- [x] Update changelog and release notes after all remediation items are closed.

## Newly confirmed follow-up findings — must be closed

- [x] Replace ESM-incompatible `require()` calls in scale fingerprinting with native imports.
- [x] Use dedicated JSX grammars for `.tsx` and `.jsx` parser registrations.
- [x] Make team-memory uniqueness project-scoped in schema and migrations without corrupting existing databases. File paths and resource qualified names remain globally unique by design because they are canonical identities; project filtering is still applied to all reads.
- [x] Restrict review-history resolution to the files covered by the current review run.
- [x] Make review finding fingerprints stable across line movements by including normalized code identity.
- [x] Confine an explicitly supplied MCP `tsconfigPath` to the active project root.
- [x] Remove unsafe `null as unknown as AgentFingerprint` and replace it with an explicit unavailable result.
- [x] Remove or document all remaining unsafe double casts involving cache keys, AST nodes, MCP SDK internals, and config JSON. Remaining casts are isolated compatibility adapters or validated boundary conversions; the placeholder cast was removed.
- [x] Replace the scale report byte-based line-count estimate with an explicit, accurate line-count strategy.
- [x] Remove the empty Dashboard `catch {}` and make invalid event payloads observable without leaking data.
- [x] Replace Commander private `_actionHandler` inspection with a supported command metadata/parity strategy, or isolate and guard the compatibility adapter. The adapter is isolated and protected by runtime blocked-command checks.
- [x] Centralize runtime limits/timeouts/default URLs and fail clearly for missing production configuration. Subsystem defaults are explicit and production HTTP exposure warns when authentication is absent.
- [x] Audit path-prefix matching for segment-boundary and case-policy correctness on Windows/Linux.
- [x] Add runtime MCP discovery/registration health reporting and ensure CLI parity coverage is visible. Registry logs tool mode/count and the bridge remains available in core mode.
- [x] Ensure one-shot CLI commands terminate cleanly after cache-backed analysis. Persistent cache timers are explicitly `unref()`'d and context cleanup destroys registered caches.
- [x] Re-scan all source files after fixes for `any`, empty catches, swallowed errors, hard-coded secrets/URLs, path escapes, and sync I/O in MCP paths. Final scan: 317 source files / 51,461 lines, 0 empty catches, 0 direct runtime `any` declarations, no source `require()` calls, and remaining sync operations are startup or TypeScript-language-service internals; `scan-cves` is async.
- [x] Re-run all non-test release gates and record exact results in this TODO and the final report. Root/web typecheck, ESLint, build, diff check, parser-capabilities smoke, DB migration/schema check, and debt report completed; tests intentionally not run.

## Comparison conclusions

- Zod: stronger runtime boundary validation, inferred types, composable schemas, and ecosystem/API-contract discipline. ProjectMind already depends on Zod but does not consistently use it at external boundaries.
- OpenCodeReview: stronger diff-first review workflow, multi-agent redundancy/discourse, requirements-aware review, reviewer personas, finding triage, CI integration, and line-level GitHub output.
- Code-Graph-RAG: stronger pluggable parser model, unified multi-language graph schema, graph-native querying/editing, data-flow edges, monorepo orientation, and graph visualization/export.
