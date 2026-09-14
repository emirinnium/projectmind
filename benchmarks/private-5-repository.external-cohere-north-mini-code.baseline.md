# ProjectMind external provider search measurement

- Provider: openrouter
- Model: cohere/north-mini-code:free
- Label status: single-reviewer
- Evaluated cases: 3
- Pricing metadata: available

| Metric | Value |
| --- | ---: |
| Precision@k | 13.33% |
| Recall@k | 100.00% |
| F1 | 23.23% |
| MRR | 52.78% |
| nDCG | 64.36% |

| Repository | Status | Cases |
| --- | --- | ---: |
| zod | completed | 2 |
| chalk | completed | 1 |
| p-map | completed | 1 |
| execa | completed | 1 |
| esbuild | completed | 1 |

## Case evidence

| Case | Status | Evaluated | Mode | Finish | MRR | Input tokens | Output tokens | Cost USD | Latency |
| --- | --- | :---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| zod/package-entrypoint-schema-api | invalid-output | no | content | length | 0.000 | 31898 | 511 | 0.00000000 | 5561 ms |
| zod/core-parse-safe-parse | invalid-output | no | content | length | 0.000 | 31902 | 511 | 0.00000000 | 4476 ms |
| chalk/terminal-ansi-styling | completed | yes | content | stop | 0.250 | 4435 | 102 | 0.00000000 | 1054 ms |
| p-map/promise-concurrency-map | completed | yes | content | stop | 1.000 | 1454 | 32 | 0.00000000 | 527 ms |
| execa/subprocess-command-execution | invalid-output | no | content | length | 0.000 | 29054 | 511 | 0.00000000 | 5048 ms |
| esbuild/npm-platform-binary-resolution | completed | yes | content | stop | 0.333 | 9353 | 74 | 0.00000000 | 1380 ms |

## Limitations

- External output is evaluated against manifest labels; single-reviewer labels are not independent ground truth.
- The model receives bounded source snippets and candidate paths, not the full repository context.
- Provider billing may include transport, system-prompt and provider-specific overhead not represented by token usage.
- zod/package-entrypoint-schema-api: provider returned no valid allowlisted path ranking; case is unmeasured.
- zod/core-parse-safe-parse: provider returned no valid allowlisted path ranking; case is unmeasured.
- execa/subprocess-command-execution: provider returned no valid allowlisted path ranking; case is unmeasured.
