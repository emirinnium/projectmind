# ProjectMind private twenty-repository baseline

This is a maintainer-only, metadata-first regression baseline. It is not a
public accuracy claim: all 20 cases currently have one local source reviewer
and therefore remain blocked from release-quality/public quality gating until
two distinct reviewers independently verify the labels.

Run conditions:

- Runner: deterministic offline lexical/static baseline; top 10 candidates
- Repositories: 20 permissively licensed JS/TS repositories
- Checkout policy: each checkout was cloned temporarily and verified against
  the immutable SHA in `private-20-repository.manifest.json`; the temporary
  directory was removed after measurement
- Manifest result input hash: `d1b9b6d9c429668fa4088c7173c67192cffa7dbf69c1b3eb67af3586ea391ac8`
- Cases: 20 evaluated, 0 unknown, 0 independently verified
- Limit: ranking metrics measure retrieval order, not semantic correctness

## Aggregate result

| Metric | Score |
| --- | ---: |
| Precision@k | 20.96% |
| Recall@k | 75.00% |
| F1 | 31.81% |
| MRR | 42.50% |
| nDCG | 50.77% |

## Repository measurements

| Repository | Files indexed | Precision@k | Recall@k | F1 | MRR | nDCG |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| zod | 516 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| chalk | 13 | 10.00% | 100.00% | 18.18% | 33.33% | 50.00% |
| p-map | 5 | 25.00% | 100.00% | 40.00% | 100.00% | 100.00% |
| execa | 565 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| esbuild | 39 | 10.00% | 100.00% | 18.18% | 100.00% | 100.00% |
| indent-string | 3 | 33.33% | 100.00% | 50.00% | 50.00% | 63.09% |
| camelcase | 3 | 33.33% | 100.00% | 50.00% | 33.33% | 50.00% |
| decamelize | 3 | 33.33% | 100.00% | 50.00% | 33.33% | 50.00% |
| strip-final-newline | 3 | 33.33% | 100.00% | 50.00% | 100.00% | 100.00% |
| p-try | 3 | 33.33% | 100.00% | 50.00% | 33.33% | 50.00% |
| is-stream | 3 | 33.33% | 100.00% | 50.00% | 33.33% | 50.00% |
| is-unicode-supported | 3 | 33.33% | 100.00% | 50.00% | 100.00% | 100.00% |
| detect-indent | 14 | 14.29% | 100.00% | 25.00% | 50.00% | 63.09% |
| clean-stack | 3 | 50.00% | 100.00% | 66.67% | 50.00% | 63.09% |
| figures | 3 | 33.33% | 100.00% | 50.00% | 50.00% | 63.09% |
| escape-string-regexp | 3 | 33.33% | 100.00% | 50.00% | 33.33% | 50.00% |
| clsx | 7 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| nanoid | 19 | 10.00% | 100.00% | 18.18% | 50.00% | 63.09% |
| uuid | 76 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| semver | 126 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |

The baseline is intentionally modest and has several zero-result cases. That
is useful regression evidence: it identifies where semantic, graph, history,
freshness and canonical-example ranking must improve. It must not be relabelled
as ProjectMind product precision/recall until the same cases have independent
labels and the production retrieval path—not only the lexical evaluator—has
been measured.

## Security-pattern measurement

Across the same temporary checkouts, with tests/spec files excluded, 766 source
files were scanned and 644 were skipped. The shared static audit rules produced
204 candidates: 0 critical, 97 high and 107 medium. These are pattern
candidates, not vulnerability counts or exploitability claims. The high-volume
results are dominated by intentionally dynamic build/test code in esbuild and
cryptographic implementation code in uuid; they require reachability and
context review before classification.

The release gate intentionally fails this baseline when
`requireIndependentLabels: true`. That failure is an evidence guard, not a
broken benchmark runner.

## Verification rerun — 2026-09-11

The same immutable 20-checkout corpus was fetched and re-run without changing
the manifest. All 20 commits and all 20 cases verified again; the deterministic
metrics and input hash were unchanged. This confirms the baseline is stable
across a fresh checkout rather than relying on a stale local directory.
