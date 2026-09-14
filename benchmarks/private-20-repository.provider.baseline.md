# ProjectMind provider baseline — private 20-repository corpus

This maintainer-only run compares the configured provider through the same
production evaluator. Only the deterministic `simple` provider was available
in the current dependency-free environment; no provider superiority claim is
made.

## Verification — 2026-09-11

- Immutable repositories: 20/20 verified.
- Provider: `simple` — 20/20 cases completed.
- Input hash: `53f33bc47340a60cc7c0d6ff5a4bf3f5993ae06ad8662d15e43f02fe8ca646d6`.
- Product-path metrics: precision@k 19.88%, recall@k 75.00%, F1 30.64%,
  MRR 28.63%, nDCG 40.18%.

Independent golden labels, an optional Transformers.js provider run, real
provider tokenizer behavior and billing/model-quality measurements remain
separate evidence requirements. The optional provider is intentionally not
installed by this baseline.
