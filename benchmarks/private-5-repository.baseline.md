# ProjectMind private five-repository baseline

This is a reproducible, metadata-first baseline for maintainers. It is not a
public accuracy claim: the six cases currently have one local source reviewer
and must be independently reviewed before release-quality metrics are
published. The manifest and immutable repository SHAs are the source of truth:
[`private-5-repository.manifest.json`](./private-5-repository.manifest.json).

Run conditions:

- Runner: deterministic offline lexical/static baseline
- Repository checkouts: exact manifest commit SHAs, cloned only into a temporary
  directory and removed after measurement
- Input hash: `a0a329a87c611a72f728b518d663671084631678a8672b51100f22955172cfd1`
- Cases: 6 evaluated, 0 unknown, 0 independently verified
- Limit: top 10 candidates; metrics are ranking metrics, not semantic proof

## Aggregate result

| Metric | Score |
| --- | ---: |
| Precision@k | 9.17% |
| Recall@k | 66.67% |
| F1 | 15.76% |
| MRR | 22.92% |
| nDCG | 33.47% |

## Repository measurements

| Repository | Files indexed | Cases | Precision@k | Recall@k | F1 | MRR | nDCG |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| zod | 516 | 2 | 5.00% | 50.00% | 9.09% | 12.50% | 21.53% |
| chalk | 13 | 1 | 10.00% | 100.00% | 18.18% | 50.00% | 63.09% |
| p-map | 5 | 1 | 25.00% | 100.00% | 40.00% | 50.00% | 63.09% |
| execa | 565 | 1 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| esbuild | 39 | 1 | 10.00% | 100.00% | 18.18% | 12.50% | 31.55% |

The low lexical baseline is useful: it establishes a regression reference and
shows where semantic, graph and history reranking must improve. It must not be
relabelled as ProjectMind product precision/recall until the same cases have
independent labels and the product retrieval path—not only the lexical
baseline—has been measured.

The release gate intentionally fails this baseline when
`requireIndependentLabels: true`. That failure is an evidence guard, not a
broken test.

## Security-pattern baseline

The same temporary checkouts produced the following static candidate counts
with tests excluded: Zod `8`, Chalk `0`, p-map `0`, Execa `0`, and esbuild
`96`. These numbers are only pattern candidates. They are not CVE counts,
exploitability findings, or proof that a repository contains a vulnerability;
taint analysis and source/runtime review are required for that classification.
