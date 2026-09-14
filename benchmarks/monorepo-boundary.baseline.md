# ProjectMind monorepo boundary baseline

- Evaluator: `projectmind-monorepo-boundary` v1
- Fixture: 240 JS/TS files across 12 packages
- Fixture hash: `7395644272c8f4a527ad7cc7c08fae440bd24c3b3bbab6064bb83645438ee887`
- Full scan: 240/240 files, 0 errors, 2,062 ms, 116 files/s
- Incremental scan: 0 files changed, 0 errors, 269 ms
- Result: `PASS`

The maintainer-only evaluator creates the fixture in a disposable temporary
directory, runs the real `ProjectScanner` full and content-addressed
incremental paths, and removes the fixture in `finally`. The regression gate
checks fixture identity, scan completeness and zero errors; timings remain
informative because they vary by runner hardware.
