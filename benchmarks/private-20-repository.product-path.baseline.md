# ProjectMind product-path baseline — private 20-repository corpus

Run date: 2026-09-10

This is an internal maintainer measurement of the real local
`ProjectScanner → KnowledgeGraph → IntentEngine.search` path. It is not a
public accuracy claim: all 20 cases currently have `single-reviewer` labels,
and no independent reviewer evidence is asserted.

## Reproducibility

- Manifest: `benchmarks/private-20-repository.manifest.json`
- Requested provider: `simple`
- Search limit: 10
- Evaluated cases: 20/20
- Verified immutable checkouts: 20/20
- Scan errors: 0
- Input hash: `a1e38aa96590e10e5f881f8acb7ee7eace0e4117db50a287885dc1fae2e26ecb`
- Temporary checkouts were removed after the run.

## Aggregate ranking metrics

| Metric | Value |
| --- | ---: |
| Precision@k | 19.88% |
| Recall@k | 75.00% |
| F1 | 30.64% |
| MRR | 28.63% |
| nDCG | 40.18% |

## Per-repository runtime

Each repository contains one manually selected search case. `Scan` is
`scanned/total files`; `Search` is the measured query latency.

| Repository | Scan | Scan duration | Search duration | Recall@k |
| --- | ---: | ---: | ---: | ---: |
| zod | 514/514 | 9454 ms | 780 ms | 0% |
| chalk | 13/13 | 266 ms | 806 ms | 100% |
| p-map | 5/5 | 175 ms | 406 ms | 100% |
| execa | 565/565 | 10238 ms | 878 ms | 0% |
| esbuild | 39/39 | 2714 ms | 686 ms | 0% |
| indent-string | 3/3 | 20 ms | 166 ms | 100% |
| camelcase | 3/3 | 85 ms | 267 ms | 100% |
| decamelize | 3/3 | 25 ms | 263 ms | 100% |
| strip-final-newline | 3/3 | 18 ms | 170 ms | 100% |
| p-try | 3/3 | 45 ms | 238 ms | 100% |
| is-stream | 3/3 | 65 ms | 258 ms | 100% |
| is-unicode-supported | 3/3 | 58 ms | 226 ms | 100% |
| detect-indent | 14/14 | 112 ms | 562 ms | 100% |
| clean-stack | 3/3 | 95 ms | 251 ms | 100% |
| figures | 3/3 | 62 ms | 189 ms | 100% |
| escape-string-regexp | 3/3 | 15 ms | 149 ms | 100% |
| clsx | 7/7 | 106 ms | 498 ms | 100% |
| nanoid | 18/18 | 445 ms | 581 ms | 100% |
| uuid | 76/76 | 741 ms | 690 ms | 0% |
| semver | 123/123 | 1529 ms | 721 ms | 0% |

## Interpretation and limitations

- The evaluator uses the production scanner, graph and intent-search path;
  it does not substitute the lexical baseline runner.
- The `simple` provider is deterministic and local, but it is not a semantic
  model-quality proxy. Provider-to-provider quality comparisons require a
  separately selected provider, model metadata, and repeatable availability.
- One manually selected expected path per repository is insufficient for a
  public golden benchmark. The release gate must continue to reject public
  quality until two distinct reviewers independently verify the labels.
- The resolver now checks exact runtime extensions before the TypeScript source
  equivalent, so JS/TS mixed projects retain their real import edges. The
  product baseline was regenerated after that change; the changed MRR/nDCG
  is a resolver correctness effect, not a semantic-model claim.
- The maintained five-repository structural fixture adds measured impact and
  review cases plus two explicitly unknown cases for clean-review semantics
  and CommonJS dead-code coverage. See
  `benchmarks/private-5-repository.structural.manifest.json` and its separate
  regression baseline; unknown cases are never promoted to quality metrics.

## Verification rerun — 2026-09-11

- Fresh immutable checkouts: 20/20 verified; product scans: 20/20 with 0
  scan errors.
- Aggregate metrics remained precision@k 19.88%, recall@k 75.00%, F1 30.64%,
  MRR 28.63% and nDCG 40.18%; input hash remained
  `a1e38aa96590e10e5f881f8acb7ee7eace0e4117db50a287885dc1fae2e26ecb`.
- The local sqlite-vec extension was unavailable in the hermetic run and the
  product path explicitly used its brute-force fallback. This is a measured
  runtime condition, not a semantic-quality claim.
