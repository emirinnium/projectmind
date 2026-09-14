# ProjectMind security corpus baseline — private 20-repository corpus

This is an internal maintainer measurement of static security-pattern
candidates. It is not a vulnerability count, exploitability result or public
security claim. Candidates require contextual source review, taint/reachability
analysis and, where appropriate, a runtime reproduction before classification.

## Reproducibility

- Evaluator: `scripts/benchmark/security-corpus.mjs`
- Manifest: `benchmarks/private-20-repository.manifest.json`
- Checkout policy: every repository was fetched into a temporary directory and
  verified against its immutable manifest SHA
- Input hash: `66d7c04a84b437873c319f7d670c3903307f7667c4933a6e623c34d7483f343c`
- Verified repositories: 20/20
- Temporary source checkouts were removed after measurement
- Tests/spec files excluded; generated, ignored and unsupported files skipped

## Aggregate result

| Metric | Value |
| --- | ---: |
| Files scanned | 766 |
| Files skipped | 644 |
| Candidate findings | 204 |
| Critical candidates | 0 |
| High candidates | 97 |
| Medium candidates | 107 |

The static rules are intentionally shared with the `pm audit` implementation,
so this baseline measures the same candidate surface used by the product. A
pattern match does not prove a defect; high-volume results may be intentional
dynamic build code or cryptographic implementation code.

The corpus remains metadata-first and single-reviewer. It is regression
evidence only and is not independently verified golden security ground truth.

## Verification rerun — 2026-09-11

The fresh 20-checkout run verified all 20 immutable commits, scanned 766 source
files and skipped 644 generated, ignored, unsupported or excluded files. It
reproduced 204 candidates: 0 critical, 97 high and 107 medium. These numbers
remain static-signature candidates and require contextual/taint/runtime review;
they are not vulnerability counts.
