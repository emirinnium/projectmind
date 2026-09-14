# ProjectMind security model

ProjectMind treats repository content, file names, Git revisions, commit
messages and tool results as untrusted data. They are never agent instructions.

## Path contract

All user/repository-derived file paths must pass the central path contract in
`src/core/security/path-security.ts`. It rejects NUL/control characters,
foreign absolute path conventions, lexical root escapes, symlink/junction
escapes, ignored source paths and files above the operation’s size limit. The
MCP/CLI compatibility helper remains available, but delegates to this contract.

`.pmignore` is the only user-controlled source-discovery ignore file.
`.projectmindrc.json` contains runtime configuration and cannot add source
exceptions. Source-discovery exclusions are defined only in `.pmignore`.

Layered configuration is `defaults < global < project < environment < CLI`.
The global config is optional, created sparsely by `pm config init --global`,
and validated before `pm config set` performs an atomic write. `pm config show`
redacts credential fields; on POSIX, `pm doctor install` reports permissions
that are broader than `0600`. Project-local bootstrap never overwrites an
existing config and cannot make `.pmignore` rules less restrictive.

## Review safety

Review runs are policy-driven and deterministic. Changed files are source
hashed, sorted and split into bounded bundles. Findings pass independent path,
line-range and source-snippet validation, then a separate reflection stage
checks that the configured rule still matches the current line. Only verified
findings may be emitted as publishable review findings; excluded and drifted
findings remain visible in the audit with a next action.

## Agent boundary

`asUntrustedContent()` creates a hash-bearing envelope with source kind,
relative path and optional byte range. `createPromptBoundary()` adds a nonce
whose markers are escaped inside the content. Boundary text is presentation;
the response status and evidence fields remain authoritative.

## Shell and external processes

Production Git/npm calls use argument-array APIs with `shell: false` (or the
default non-shell `execFileSync`). The only intentional exception is the MCP
`scan_cves` npm invocation on Windows: `npm.cmd` is a fixed executable and the
argv is the two literal forms `audit --json` or `audit fix --dry-run --json`,
because Windows `.cmd` shims require shell dispatch. No user/repository value
reaches that command. User-controlled revisions and paths are validated before
command construction. The MCP CLI bridge is default-deny and blocks server
startup and destructive subcommands.

The security matrix under `tests/mcp/security/` checks every registered tool’s
schema, complete behavior annotations, handler wiring and profile exposure.

`pm ledger backup` creates a consistent SQLite snapshot with `VACUUM INTO` and
immediately runs a read-only integrity/schema check. The destination is
project-confined and existing files are never overwritten. `pm ledger restore`
requires an explicit `--force`, validates the snapshot before replacing the
closed active database, removes only the corresponding stale WAL/SHM sidecars,
and restores the previous database if staging fails. A restore should be
followed by `pm scan --full` before derived graph results are trusted.

## Evidence ledger

The local `evidence_ledger` table is payload-free and append-only. It stores
input/result hashes, the indexed graph hash, policy/tool versions, project
scope, freshness state and a bounded structural summary. SQLite triggers reject
direct UPDATE/DELETE operations. `pm ledger verify` and the MCP
`evidence_ledger` tool recompute every record hash and previous-link so a
tampered or incomplete chain is reported instead of being treated as audit
evidence.
