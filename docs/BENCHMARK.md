# ProjectMind benchmark protocol

ProjectMind’s benchmark is metadata-first. A published corpus must record the
repository URL, immutable commit SHA, license, language/runtime, and the exact
golden labels used for each case. Do not commit source from a third-party
repository unless its license explicitly permits redistribution.

## Local fixture workflow

```bash
pm benchmark prepare --output .projectmind/benchmark-manifest.json
# Edit expectedPaths only after independent human verification.
pm benchmark run --manifest .projectmind/benchmark-manifest.json --format markdown
pm benchmark search --query "authentication token" --limit 10 --format markdown
pm benchmark review --base main --head HEAD --format markdown
pm benchmark corpus validate --manifest benchmarks/corpus.manifest.json
```

Each case declares `expectedPaths`, accepted aliases, a query kind, and an
optional `unknown` flag. Unknown cases remain in the report but are excluded
from precision/recall/MRR/nDCG averages. The runner is offline and
deterministic: it only reads JS/TS source in the configured project root,
sorts paths canonically, and records a SHA-256 input hash.

## Reporting rules

Precision@k, recall@k, reciprocal rank and nDCG are ranking metrics, not proof
that a result is semantically correct. Review, impact and dead-code cases must
have independently verified labels and should include an explicit unknown
class for dynamic/runtime behavior. A release must report the fixture version,
input hash, evaluated/unknown case counts, cold/warm latency, output bytes and
estimated/actual tokens separately.

The initial runner provides an offline lexical baseline. Embedding, graph,
history and review-specific evaluators are layered on top of the same manifest
contract so improvements are measurable against a stable baseline rather than
against a model’s self-judgment.

## Current published corpus status

`benchmarks/corpus.manifest.json` is a public metadata-first smoke manifest. It
records ProjectMind’s immutable commit and license metadata plus two local
search cases; it deliberately does not redistribute third-party source. It is
useful for validating the corpus contract, but it is not a 20–50 repository
golden benchmark and must not be presented as one. Expanding it requires
independent label review, license verification and reproducible checkout
automation for each repository.

The offline runner currently evaluates `search` cases. `impact`, `dead-code`
and `review` cases are retained as explicit `unknown` cases until their
domain-specific evaluators and independently verified labels are available.
This prevents a lexical approximation from inflating product accuracy claims.

`pm benchmark review` measures changed-file coverage, deterministic bundle
composition, finding position validation and reflection. It does not claim to
measure the semantic quality of an external model reviewer. `pm benchmark mcp`
records safe cold/warm invocations, output bytes and bounded token estimates;
required-input, mutating and network-facing tools are reported as intentionally
skipped rather than fabricated invocations.
