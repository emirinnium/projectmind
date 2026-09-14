# Dependency decisions

## `@huggingface/transformers`

ProjectMind supports the official `@huggingface/transformers` 4.x package as an
optional embedding and tokenizer provider. Transformers.js moved from the
historical Xenova package to the official Hugging Face package; ProjectMind's
usage is limited to the stable `pipeline` and `AutoTokenizer` APIs. It is declared as an optional peer dependency and is not
imported by the core CLI/MCP path unless a transformer provider is requested.
This keeps the default global/local install free of the native transformer
chain and its installation warnings. Users who need it install
`@huggingface/transformers` and, for local ONNX model providers,
`onnxruntime-node` explicitly in the same scope as ProjectMind. The migration
keeps model names and embedding dimensions configurable; provider smoke tests
must still validate the selected model's output dimension.
The simple provider keeps installation and offline operation usable when these
optional packages are absent.

## `onnxruntime-node` / `adm-zip` / `sharp`

The package pins safe compatible `sharp`, `hono`, `adm-zip` and related
transitive versions through `overrides`. The transformer/ONNX chain is no
longer installed by the core package, so the optional `onnxruntime-node` →
`adm-zip` moderate advisory does not affect a default core install. When a user
explicitly installs that provider, `npm audit --omit=dev` may still report the
advisory because the available audit fix is a breaking runtime downgrade. The
package does not recommend `npm audit fix --force`; core analysis remains
available without the optional provider.

## Native install warning

An explicitly installed optional native provider may emit a
`prebuild-install` deprecation warning from its upstream dependency chain. It
is not hidden or converted into a false success. The core package installation
does not install that chain, and `pm doctor install` reports provider
availability plus the deterministic simple fallback; no `--legacy-peer-deps`
flag is required.

## Direct dependency surface

The unused direct dependencies `ws`, `ts-node`, `tsconfig-paths` and
`eslint-plugin-import` were removed from the manifest and lockfile. They were
not part of the production CLI/MCP runtime or the configured lint pipeline.
The lockfile is regenerated from `package.json`, and clean-install validation
uses `npm ci`; users do not need `--legacy-peer-deps`.

## Publisher identity

The npm scope `@emirhanturker` and GitHub owner `emirinnium` are intentionally
different publisher identities. Package metadata, homepage, issues URL and
README all point to the canonical ProjectMind repository and npm package; no
rename is made without explicit maintainer approval.
