# ProjectMind external provider search measurement

- Provider: openrouter
- Model: cohere/north-mini-code:free
- Label status: single-reviewer
- Evaluated cases: 17
- Pricing metadata: available

| Metric | Value |
| --- | ---: |
| Precision@k | 22.21% |
| Recall@k | 94.12% |
| F1 | 35.41% |
| MRR | 65.88% |
| nDCG | 73.14% |

| Repository | Status | Cases |
| --- | --- | ---: |
| zod | completed | 1 |
| chalk | completed | 1 |
| p-map | completed | 1 |
| execa | completed | 1 |
| esbuild | completed | 1 |
| indent-string | completed | 1 |
| camelcase | completed | 1 |
| decamelize | completed | 1 |
| strip-final-newline | completed | 1 |
| p-try | completed | 1 |
| is-stream | completed | 1 |
| is-unicode-supported | completed | 1 |
| detect-indent | completed | 1 |
| clean-stack | completed | 1 |
| figures | completed | 1 |
| escape-string-regexp | completed | 1 |
| clsx | completed | 1 |
| nanoid | completed | 1 |
| uuid | completed | 1 |
| semver | completed | 1 |

## Case evidence

| Case | Status | Evaluated | Mode | Finish | MRR | Input tokens | Output tokens | Cost USD | Latency |
| --- | --- | :---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| zod/zod-entry | completed | yes | content | stop | 0.000 | 31886 | 56 | 0.00000000 | 2259 ms |
| chalk/chalk-entry | completed | yes | content | stop | 1.000 | 4422 | 100 | 0.00000000 | 987 ms |
| p-map/p-map-entry | completed | yes | content | stop | 1.000 | 1439 | 16 | 0.00000000 | 681 ms |
| execa/execa-entry | invalid-output | no | content | length | 0.000 | 29039 | 511 | 0.00000000 | 20176 ms |
| esbuild/esbuild-node-entry | completed | yes | content | stop | 0.200 | 9340 | 256 | 0.00000000 | 4260 ms |
| indent-string/indent-string-entry | completed | yes | content | stop | 0.500 | 911 | 22 | 0.00000000 | 785 ms |
| camelcase/camelcase-entry | completed | yes | content | stop | 0.500 | 1142 | 22 | 0.00000000 | 1765 ms |
| decamelize/decamelize-entry | completed | yes | content | stop | 0.500 | 961 | 13 | 0.00000000 | 1006 ms |
| strip-final-newline/strip-final-newline-entry | completed | yes | content | stop | 1.000 | 770 | 22 | 0.00000000 | 594 ms |
| p-try/p-try-entry | completed | yes | content | stop | 0.500 | 503 | 22 | 0.00000000 | 666 ms |
| is-stream/is-stream-entry | completed | yes | content | stop | 0.500 | 975 | 22 | 0.00000000 | 1005 ms |
| is-unicode-supported/is-unicode-supported-entry | completed | yes | content | stop | 1.000 | 521 | 18 | 0.00000000 | 2941 ms |
| detect-indent/detect-indent-entry | completed | yes | content | stop | 0.500 | 2096 | 16 | 0.00000000 | 1294 ms |
| clean-stack/clean-stack-entry | completed | yes | content | stop | 1.000 | 894 | 22 | 0.00000000 | 551 ms |
| figures/figures-entry | completed | yes | content | stop | 0.500 | 970 | 22 | 0.00000000 | 916 ms |
| escape-string-regexp/escape-string-regexp-entry | completed | yes | content | stop | 1.000 | 519 | 18 | 0.00000000 | 782 ms |
| clsx/clsx-entry | completed | yes | content | stop | 1.000 | 1791 | 44 | 0.00000000 | 3074 ms |
| nanoid/nanoid-entry | completed | yes | content | stop | 0.500 | 4054 | 30 | 0.00000000 | 730 ms |
| uuid/uuid-entry | failed | no | n/a | n/a | 0.000 | n/a | n/a | n/a | n/a ms |
| semver/semver-entry | failed | no | n/a | n/a | 0.000 | n/a | n/a | n/a | n/a ms |

## Limitations

- External output is evaluated against manifest labels; single-reviewer labels are not independent ground truth.
- The model receives bounded source snippets and candidate paths, not the full repository context.
- Provider billing may include transport, system-prompt and provider-specific overhead not represented by token usage.
- execa/execa-entry: provider returned no valid allowlisted path ranking; case is unmeasured.
- uuid/uuid-entry: OpenRouter API error: 429 {"error":{"message":"Rate limit exceeded: cohere/north-mini-code-20260617/d3a18412-b833-40de-bc07-c4ba9a1dea53. High demand for cohere/north-mini-code:free on OpenRouter - limited to 15 requests per minute. Please retry shortly.","code":429,"metadata":{"headers":{"X-RateLimit-Limit":"15","X-RateLimit-Remaining":"0","X-RateLimit-Reset":"1789138080000"},"limit_source":"openrouter_shared_capacity","remedy_hint":"Retry shortly, or add your own provider key to use your own l
- semver/semver-entry: OpenRouter API error: 429 {"error":{"message":"Rate limit exceeded: cohere/north-mini-code-20260617/d3a18412-b833-40de-bc07-c4ba9a1dea53. High demand for cohere/north-mini-code:free on OpenRouter - limited to 15 requests per minute. Please retry shortly.","code":429,"metadata":{"headers":{"X-RateLimit-Limit":"15","X-RateLimit-Remaining":"0","X-RateLimit-Reset":"1789138080000"},"limit_source":"openrouter_shared_capacity","remedy_hint":"Retry shortly, or add your own provider key to use your own l
