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
exceptions through `ignorePatterns`.

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
default non-shell `execFileSync`). User-controlled revisions and paths are
validated before command construction. The MCP CLI bridge is default-deny and
blocks server startup and destructive subcommands.

The security matrix under `tests/mcp/security/` checks every registered tool’s
schema, complete behavior annotations, handler wiring and profile exposure.
