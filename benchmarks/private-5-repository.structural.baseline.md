# ProjectMind structural product baseline — private five-repository fixture

This is an internal maintainer measurement of the production
`ProjectScanner → KnowledgeGraph → IntentEngine` path plus the production
review rule/position/reflection path. It is not a public accuracy claim: all
labels are single-reviewer and the two independent-label gates remain closed.

## Reproducibility

- Manifest: `benchmarks/private-5-repository.structural.manifest.json`
- Requested provider: `simple`
- Verified immutable checkouts: 5/5
- Cases: 6
- Evaluated cases: 4
- Explicit unknown cases: 2
- Scan errors: 0
- Input hash: `f9dac522a3c9582b467cff837c180de10a8a12f15104e6cec3d673da08af2baa`
- Temporary checkouts were removed after the run.

## Aggregate metrics for measured cases

| Metric | Value |
| --- | ---: |
| Precision@k | 100.00% |
| Recall@k | 100.00% |
| F1 | 100.00% |
| MRR | 100.00% |
| nDCG | 100.00% |

## Case coverage

| Repository | Case | Kind | Status |
| --- | --- | --- | --- |
| zod | classic-external-impact | impact | measured |
| execa | create-impact | impact | measured |
| uuid | stringify-impact | impact | measured |
| uuid | v35-review | review | measured |
| nanoid | entry-review-no-findings | review | unknown |
| semver | commonjs-dead-code | dead-code | unknown |

The nanoid case remains unknown because “no default rule match” is not a
semantic proof that a review is clean. The semver case remains unknown because
CommonJS graph coverage was not sufficient to produce a trustworthy dead-code
label at the time of fixture selection. Unknown cases are retained in reports,
but never enter the aggregate metrics.

The fixture validates that impact and review wiring preserves source-inspected
paths through the production graph and verification stages. It does not claim
that four single-reviewer cases establish semantic quality; independent labels,
larger coverage and external reviewer comparisons are required for that.
