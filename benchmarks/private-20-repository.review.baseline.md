# ProjectMind review fixture baseline — private 20-repository corpus

This maintainer-only measurement exercises the process-isolated deterministic
review fixture against one manifest-selected source file per repository. It
measures bundle execution, line-position validation and reflection; it does
not measure external reviewer/model quality.

## Verification — 2026-09-11

- Immutable repositories: 20/20 verified.
- Review cases: 20/20 completed.
- Bundles: 20 completed, 0 failed.
- Generated findings: 8.
- Position/reflection-verified findings: 8/8.
- Tokenizer mode: heuristic.
- Temporary source checkouts were removed after the run.

The deterministic fixture is deliberately not promoted to an external-model
accuracy claim. Public review quality still requires independently labeled
findings, production-like diff distributions and an external reviewer/model
measurement.
