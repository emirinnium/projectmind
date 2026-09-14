# ProjectMind external provider search measurement

- Provider: openrouter
- Model: deepseek/deepseek-v4-flash:free
- Label status: single-reviewer
- Evaluated cases: 0
- Pricing metadata: not supplied

| Metric | Value |
| --- | ---: |
| Precision@k | 0.00% |
| Recall@k | 0.00% |
| F1 | 0.00% |
| MRR | 0.00% |
| nDCG | 0.00% |

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
| zod/package-entrypoint-schema-api | failed | no | n/a | n/a | 0.000 | n/a | n/a | n/a | n/a ms |
| zod/core-parse-safe-parse | failed | no | n/a | n/a | 0.000 | n/a | n/a | n/a | n/a ms |
| chalk/terminal-ansi-styling | failed | no | n/a | n/a | 0.000 | n/a | n/a | n/a | n/a ms |
| p-map/promise-concurrency-map | failed | no | n/a | n/a | 0.000 | n/a | n/a | n/a | n/a ms |
| execa/subprocess-command-execution | failed | no | n/a | n/a | 0.000 | n/a | n/a | n/a | n/a ms |
| esbuild/npm-platform-binary-resolution | failed | no | n/a | n/a | 0.000 | n/a | n/a | n/a | n/a ms |

## Limitations

- External output is evaluated against manifest labels; single-reviewer labels are not independent ground truth.
- The model receives bounded source snippets and candidate paths, not the full repository context.
- Provider billing may include transport, system-prompt and provider-specific overhead not represented by token usage.
- zod/package-entrypoint-schema-api: OpenRouter API error: 404 {"error":{"message":"This model is unavailable for free. The paid version is available now - use this slug instead: deepseek/deepseek-v4-flash","code":404},"user_id":"user_3HaLjLDRcfWgBzkJ9fDqTqc6Zlf"}
- zod/core-parse-safe-parse: OpenRouter API error: 404 {"error":{"message":"This model is unavailable for free. The paid version is available now - use this slug instead: deepseek/deepseek-v4-flash","code":404},"user_id":"user_3HaLjLDRcfWgBzkJ9fDqTqc6Zlf"}
- chalk/terminal-ansi-styling: OpenRouter API error: 404 {"error":{"message":"This model is unavailable for free. The paid version is available now - use this slug instead: deepseek/deepseek-v4-flash","code":404},"user_id":"user_3HaLjLDRcfWgBzkJ9fDqTqc6Zlf"}
- p-map/promise-concurrency-map: OpenRouter API error: 404 {"error":{"message":"This model is unavailable for free. The paid version is available now - use this slug instead: deepseek/deepseek-v4-flash","code":404},"user_id":"user_3HaLjLDRcfWgBzkJ9fDqTqc6Zlf"}
- execa/subprocess-command-execution: OpenRouter API error: 404 {"error":{"message":"This model is unavailable for free. The paid version is available now - use this slug instead: deepseek/deepseek-v4-flash","code":404},"user_id":"user_3HaLjLDRcfWgBzkJ9fDqTqc6Zlf"}
- esbuild/npm-platform-binary-resolution: OpenRouter API error: 404 {"error":{"message":"This model is unavailable for free. The paid version is available now - use this slug instead: deepseek/deepseek-v4-flash","code":404},"user_id":"user_3HaLjLDRcfWgBzkJ9fDqTqc6Zlf"}
