# ProjectMind provider comparison

- Baseline provider: simple
- Complete: no
- Input hash: `ae21923ad0ddcb11939f70aea4aaaf416ef11b32c570d1134ec18bccf5423e6c`

| Provider | Status | Active provider | Evaluated cases | Precision@k | Recall@k | F1 | MRR | nDCG |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| simple | completed | simple | 20 | 19.88% | 75.00% | 30.64% | 33.63% | 43.87% |
| transformers | fallback | simple | 20 | 19.88% | 75.00% | 30.64% | 33.63% | 43.87% |

## Limitations

- Provider deltas compare the same local evaluator and corpus; they do not establish semantic model quality.
- A provider fallback is reported as evidence and is not treated as the requested provider result.
- Independent golden labels are required before publishing accuracy or provider superiority claims.
- zod: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- zod: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- chalk: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- chalk: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- p-map: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- p-map: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- execa: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- execa: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- esbuild: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- esbuild: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- indent-string: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- indent-string: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- camelcase: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- camelcase: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- decamelize: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- decamelize: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- strip-final-newline: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- strip-final-newline: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- p-try: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- p-try: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- is-stream: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- is-stream: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- is-unicode-supported: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- is-unicode-supported: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- detect-indent: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- detect-indent: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- clean-stack: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- clean-stack: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- figures: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- figures: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- escape-string-regexp: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- escape-string-regexp: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- clsx: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- clsx: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- nanoid: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- nanoid: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- uuid: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- uuid: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
- semver: Requested provider "transformers" was unavailable and the runtime is using "simple" instead.
- semver: The fallback provider may have different semantic quality and vector characteristics; verify the active provider before comparing or indexing embeddings.
