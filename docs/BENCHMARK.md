# ProjectMind benchmark protocol

ProjectMind’s benchmark is metadata-first. A published corpus must record the
repository URL, immutable commit SHA, license, language/runtime, and the exact
golden labels used for each case. Do not commit source from a third-party
repository unless its license explicitly permits redistribution.

## Local fixture workflow

The benchmark runner is an internal verification harness under
`scripts/benchmark/`; it is not part of the production `src` tree and is not
exposed as a public `pm` command. Run it from the repository's
test/maintenance workflow; do not present its reports as a user-facing
ProjectMind feature.

Each case declares `expectedPaths`, accepted aliases, a query kind, and an
optional `unknown` flag. Product impact cases declare `targetPath`; product
review cases declare `changedPaths`. Unknown cases remain in the report but are excluded
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

The internal `scripts/benchmark/product.mjs` evaluator exercises the real local
`ProjectScanner → KnowledgeGraph → IntentEngine.search` path. It creates a fresh
in-memory database for every checkout, verifies immutable commits by default,
records provider fallback and scan errors, normalizes results to safe
repository-relative paths. `search` cases use the real intent engine, while
`impact`, `dead-code` and `review` cases are scored when required contract
fields exist; cases without those fields remain explicitly
unmeasured until their maintained fixture contracts exist. This evaluator is
maintainer-only and is not included in the published package or exposed as
`pm benchmark`.

The internal `scripts/benchmark/tokenizer.mjs` measures the production context
tokenizer against a small JS/TS fixture set. It reports UTF-8 bytes, heuristic
tokens, provider-tokenizer tokens and repeated-call latency while hashing the
fixture contents instead of returning them. The default heuristic mode is
offline and deterministic; Transformers.js mode is explicit and may require
the optional model/cache. This is a script-only maintainer measurement, not a
public benchmark command.

The current private 20-repository product-path result is recorded in
`benchmarks/private-20-repository.product-path.baseline.md`. It is a real
production-path baseline using the deterministic `simple` provider, not a
model-quality claim; independent labels and provider comparisons remain gated.

The latest maintainer-only external observation is recorded in
`benchmarks/private-20-repository.external-cohere-north-mini-code.baseline.md`.
It contains sanitized provider metadata and hashes only. Its 17/20 evaluated
cases remain single-reviewer evidence; rate-limited or invalid responses are
excluded from quality aggregates, and the report must not be presented as a
golden accuracy benchmark.

## Independent label workflow

Maintainers can prepare source-redacted label packets without exposing the
existing answers to a reviewer:

```text
node scripts/benchmark/label-kit.mjs create \
  --manifest benchmarks/private-20-repository.manifest.json \
  --reviewer reviewer-a --out .private/reviewer-a.json
```

Give the same immutable checkouts and a separately generated packet to at least
two reviewers. Each reviewer fills every packet case with `expectedPaths`, an
explicit `unknown` decision, a labeling method and source-backed evidence. The
packet is bound to the exact manifest SHA-256, and repository-relative paths are
validated before they can be used. Verify submissions without writing anything:

```text
node scripts/benchmark/label-kit.mjs verify \
  --manifest benchmarks/private-20-repository.manifest.json \
  --labels .private/reviewer-a.json,.private/reviewer-b.json
```

Only unanimous labels from distinct reviewer identifiers can be merged, and
merge refuses to overwrite the input manifest:

```text
node scripts/benchmark/label-kit.mjs merge \
  --manifest benchmarks/private-20-repository.manifest.json \
  --labels .private/reviewer-a.json,.private/reviewer-b.json \
  --out .private/private-20-repository.independent.manifest.json
```

This workflow verifies submission completeness and reproducible provenance; it
cannot prove that a reviewer identity is genuine or replace human adjudication.
Do not mark labels independently verified unless the reviewers actually
inspected the pinned source and the evidence is retained. The packet and label
files are maintainer-only and must not be published with third-party source.

The maintainer-only `scripts/benchmark/review-provider.mjs` fixture executes
each deterministic review bundle in a disposable Node process. It reuses the
production review rule collector, independent line-position validator and
reflection gate, then exposes only sanitized finding metadata (never source
snippets). The result includes bundle status, estimated input tokens, optional
provider-tokenizer counts, output bytes and verified findings. The accompanying
`renderIsolatedReviewBenchmarkMarkdown` and
`renderIsolatedReviewBenchmarkSarif` functions produce internal artifacts;
SARIF contains only verified line findings. This fixture validates process
isolation and reporting mechanics, not the semantic quality of an external
review model. Select `tokenizerMode: 'transformers'` only when the optional
Transformers.js dependency/model is deliberately available; the default
heuristic mode remains offline and deterministic.

`scripts/benchmark/provider-comparison.mjs` runs the same product evaluator
once per explicitly selected embedding provider, with a fresh graph/database
namespace for every run. It reports aggregate metric deltas against a named
baseline, active-versus-requested provider identity and fallback limitations.
Provider comparison is reproducible infrastructure for a future independently
labeled corpus, not evidence that one provider is semantically superior on an
unlabeled smoke corpus.

For a real external LLM retrieval observation, the maintainer-only
`scripts/run-external-provider-benchmark.mjs` wrapper sends bounded source
snippets from pre-existing, immutable checkouts to the selected provider. It
records provider response mode, finish reason, token usage, optional pricing
metadata, latency and allowlisted-path ranking metrics without storing source
or model response text. Use `--reasoning-effort none` when a reasoning model's
internal budget would otherwise exhaust `max_tokens` before returning the JSON
ranking. `reasoning-only`, empty, malformed or out-of-bound responses are
reported as unmeasured and are excluded from quality aggregates. The wrapper
requires `OPENROUTER_API_KEY` in the process environment, never reads or writes
project credentials, never clones repositories and never promotes
single-reviewer labels to independent ground truth:

```bash
OPENROUTER_API_KEY=... node scripts/run-external-provider-benchmark.mjs \
  --root <checkout-root> \
  --manifest benchmarks/private-5-repository.manifest.json \
  --model cohere/north-mini-code:free \
  --reasoning-effort none \
  --report <report.md>
```

On PowerShell, set the process-local variable instead:

```powershell
$env:OPENROUTER_API_KEY = '...'
node scripts/run-external-provider-benchmark.mjs `
  --root <checkout-root> `
  --manifest benchmarks/private-5-repository.manifest.json `
  --model cohere/north-mini-code:free `
  --reasoning-effort none `
  --report <report.md>
Remove-Item Env:OPENROUTER_API_KEY
```

For a maintainer run, use
`node scripts/run-provider-comparison.mjs --root <checkout-root> --providers simple,transformers`.
The wrapper never clones or fetches a repository, verifies recorded commits by
default and returns non-zero if any selected provider cannot complete. It is
not included in the npm package and is not exposed as a `pm` command.

## Current published corpus status

`benchmarks/corpus.manifest.json` is a public metadata-first smoke manifest. It
records ProjectMind’s immutable commit and license metadata plus two local
search cases; it deliberately does not redistribute third-party source. It is
useful for validating the corpus contract, but it is not a 20–50 repository
golden benchmark and must not be presented as one. Expanding it requires
independent label review, license verification and reproducible checkout
automation for each repository.

The offline runner evaluates `search`, `impact`, `dead-code` and `review` cases
with separate deterministic evaluators. These are baseline measurements, not a
claim that lexical matching proves semantic impact, dead code, or review
correctness. Dynamic/runtime behavior must be represented as `unknown` or
validated by the corresponding product pipeline.

Security candidates have a separate internal
`scripts/benchmark/security.mjs` runner. It shares the exact static signatures
with `pm audit`, records an input hash, line-level candidates, severity counts
and explicit limitations. A finding is never promoted to a vulnerability
solely because a pattern matched.

The five-repository private baseline is recorded in
`benchmarks/private-5-repository.manifest.json`. It contains immutable SHA
metadata and manually selected entry-point cases, but its current labels are
`single-reviewer`; it is therefore useful for private regression work and is
not a public accuracy claim. `independently-verified` labels require two
distinct reviewer identifiers and evidence, and the gate refuses public
quality status until that condition is met.

The expanded private baseline is recorded in
`benchmarks/private-20-repository.manifest.json`, with its measured result in
`benchmarks/private-20-repository.baseline.md`. It covers 20 permissively
licensed JS/TS repositories and 20 deterministic entry-point cases. The
checkout SHAs were verified during the recorded run and the source checkouts
were removed afterward. Its labels remain `single-reviewer`, so the report is
regression evidence rather than a public product-quality or accuracy claim.

The private structural fixture is recorded in
`benchmarks/private-5-repository.structural.manifest.json`. It reuses five
immutable checkouts to exercise the real product impact and review paths. Four
cases are measured from source-inspected labels; one clean-review case and one
CommonJS dead-code case are explicit `unknown` cases because the current
evidence cannot support a trustworthy quality label. Its separate regression
baseline therefore requires four evaluated cases, while the report retains all
six cases and their limitations. The recorded evidence is kept in
`benchmarks/private-5-repository.structural.baseline.md`.

The scheduled/manual maintainer workflow
`.github/workflows/private-corpus-regression.yml` fetches each recorded SHA
into the runner’s temporary directory and invokes
`scripts/run-private-corpus.mjs`. The script writes only the CI artifact,
requires every case and checkout to be evaluated/verified, and keeps the
independent-label gate opt-in so a pending label is never silently promoted to
public truth. This is intentionally separate from the public `pm` CLI.

The same workflow also runs the production-path evaluator and compares both
JSON results with the maintainer-only
`benchmarks/private-20-repository.regression-baseline.json` through
`scripts/benchmark/check-regression.mjs`. The gate fails on corpus input-hash
drift, missing case parity, product scan errors or an absolute ranking-metric
drop above the recorded policy. Updating a baseline is a deliberate
corpus/evaluator change and requires reviewing the generated Markdown evidence
first.

The workflow also runs the structural fixture against the already verified
five-repository checkouts and compares it with
`benchmarks/private-5-repository.structural.regression-baseline.json`. This
keeps impact/review wiring in regression coverage without fabricating a
dead-code score where CommonJS resolution is not yet complete.

The same workflow runs `scripts/benchmark/cross-project.mjs` against the real
`zod` and `execa` immutable checkouts. It creates both projects through the
actual CLI, scans them into one temporary SQLite store, verifies every stored
path remains inside its owning checkout and removes the store after the run.
`scripts/benchmark/check-cross-project-regression.mjs` fails closed if the
repository set, commit verification, scan-error bound or isolation invariant
changes. The metadata-only result is recorded in
`benchmarks/private-2-repository.cross-project.baseline.md`; no third-party
source is committed or published.

The monorepo boundary is measured separately by
`scripts/benchmark/monorepo.mjs`. Its disposable 240-file/12-package fixture
exercises the real full and content-addressed incremental scanner paths.
`scripts/benchmark/check-monorepo-regression.mjs` gates fixture identity,
completeness and zero scan errors while leaving absolute latency as an
environment-dependent trend value. The current metadata-only baseline is
`benchmarks/monorepo-boundary.baseline.md`.

Before the semantic evaluators run, the same maintainer workflow invokes
`scripts/benchmark/corpus-contract.mjs`. This fail-closed contract check
verifies that every manifest checkout resolves to the recorded commit, that
expected case paths are repository-relative, present and Git-tracked, and
that basic package metadata points at existing source files. It also records
source-file/LOC metadata without copying source content into the report. This
is corpus integrity evidence only: it does not create independent labels or
turn an automated case into a public accuracy claim.

The benchmark contract is enforced in CI by running the benchmark and CLI
isolation tests directly with Vitest. There is intentionally no public
`pm benchmark` command: release users get the analysis tools, while benchmark
fixtures and reports remain a maintainer/research workflow.

The scheduled corpus workflow also invokes
`scripts/run-private-security-corpus.mjs`. It verifies every checkout against
the manifest SHA, aggregates the shared static-audit candidates by severity and
uploads both Markdown and JSON evidence. Missing checkouts or unverifiable
commits fail the maintenance run; candidate increases/decreases are not called
vulnerabilities without contextual reachability review.

The recorded 20-repository security baseline is
`benchmarks/private-20-repository.security.baseline.md`. Its input hash and
aggregate counts are evidence for reproducing the static candidate surface;
they are not a security score.

`benchmarks/private-20-repository.security.regression-baseline.json` is used by
the maintainer workflow to detect unreviewed changes to the corpus hash,
checkout verification, scanned-file counts or static rule candidate counts.
Changes to the audit rules must update that baseline only together with a
review of the Markdown evidence.

For a maintainer run over the expanded local checkout set, use
`node scripts/run-private-product-corpus.mjs --root <checkout-root>`. The
wrapper is intentionally outside the package CLI, verifies commit SHAs by
default, and can emit a Markdown artifact with `--report`. A fixture with
known `unknown` cases may set the explicit maintainer-only
`--minimum-evaluated-cases <n>` threshold; this never converts unknown cases
into scores. `--provider simple` is the deterministic local default, while
optional providers must be selected explicitly and their fallback status is
recorded.

The corpus runner evaluates the same manifest against pre-existing local
checkouts under the supplied repository directory (`<root>/<repository-id>`).
It performs no clone/fetch/network operation. By default each checkout must be
at the immutable `commitSha` recorded in the manifest; `--skip-commit-check` is
available only for local fixture development and must not be used for a
published score. Missing, non-Git, or mismatched checkouts are reported as
limitations and do not receive fabricated scores.

Review bundle execution is bounded independently from MCP invocation
benchmarking. `concurrency`, `bundleTimeoutMs` and `bundleRetries` are parsed
from the review policy, while the final result is returned in canonical bundle
order. Timeout cancellation is cooperative for asynchronous providers; a
non-cooperative handler belongs in a process-isolated fixture and is reported
as incomplete rather than as a successful review.

The review benchmark measures changed-file coverage, deterministic bundle
composition, finding position validation and reflection. It does not claim to
measure the semantic quality of an external model reviewer. The MCP benchmark
records safe cold/warm invocations, input/output bytes, compatibility token
estimates, optional provider-tokenizer counts, p50/p95/p99 latency and
output-budget overruns. Required-input, mutating, heavy
and network-facing tools are reported as intentionally skipped rather than
fabricated invocations. Each in-process fixture is awaited with a bounded
timeout; the timeout does not forcibly stop a non-cooperative synchronous
handler, so those handlers belong in a worker-isolated benchmark. The internal
runner accepts a 250–60000 ms per-invocation timeout; this is an API/test
option, not a public `pm` command or a user-facing CLI promise.

For heavy or non-cooperative MCP fixtures, call the internal runner with
`isolated: true`. The isolated MCP benchmark launches a disposable Node worker
with an argument array and `shell:false`; the worker emits one JSON result on
stdout and all diagnostics on stderr. The parent process applies a hard upper
bound and kills the worker if it outlives the bounded benchmark window.

`scripts/benchmark/runner.mjs` provides `renderBenchmarkMarkdown`,
`renderCorpusBenchmarkMarkdown` and `renderBenchmarkSarif` as programmatic
report renderers. SARIF entries
intentionally contain file-level `note` observations, not line-level review
findings, severities, or vulnerability claims. `evaluateBenchmarkGate` fails
explicitly for missing evaluations, unverified commits, or missing independent
labels; it never turns missing evidence into a passing score. A release-facing
score requires independently reviewed labels and should publish the manifest
SHA, checkout SHA, evaluated/unknown counts, limitations and provider/tokenizer
details alongside the rendered artifact.
