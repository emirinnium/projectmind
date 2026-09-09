# Dependency decisions

## `@xenova/transformers`

ProjectMind currently uses `@xenova/transformers` 2.x as an optional embedding
provider. It is not imported by the core CLI/MCP path unless a transformer
provider is requested. A migration to a newer Transformers.js package is not
performed solely for scanner score: model names, ONNX runtime behavior and
embedding dimensions must be benchmarked together. The simple provider keeps
installation and offline operation usable when optional packages are absent.

## `onnxruntime-node` / `adm-zip` / `sharp`

The package pins safe compatible `sharp`, `hono`, `adm-zip` and related
transitive versions through `overrides`. `npm audit --omit=dev` may still show
the optional `onnxruntime-node` → `adm-zip` moderate advisory because the
available audit fix is a breaking runtime downgrade. The package does not
recommend `npm audit fix --force`; the optional provider can be omitted and
core analysis remains available.

## Native install warning

Some optional native dependency chains can still emit a `prebuild-install`
deprecation warning. It is not hidden or converted into a false success.
`pm doctor install` reports optional-provider availability and the simple
fallback path, so a clean core installation does not require
`--legacy-peer-deps`.

## Publisher identity

The npm scope `@emirhanturker` and GitHub owner `emirinnium` are intentionally
different publisher identities. Package metadata, homepage, issues URL and
README all point to the canonical ProjectMind repository and npm package; no
rename is made without explicit maintainer approval.
