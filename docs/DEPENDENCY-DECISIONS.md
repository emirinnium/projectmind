# Dependency and publisher decisions

## `@xenova/transformers`

ProjectMind currently keeps `@xenova/transformers@^2.17.2` as an optional
dependency. The embedding adapter imports the v2 API (`pipeline`) lazily, so
installing the base CLI does not require the transformer runtime.

Transformers.js moved to the `@huggingface/transformers` package in v3 and the
current package line is a major-version change. Migrating only to satisfy a
freshness scanner would risk changing model loading, runtime selection, model
cache behavior, and embedding compatibility for existing users. The current
decision is therefore:

- classify the old package as a confirmed maintenance/freshness finding;
- keep it for 1.0.x compatibility;
- plan a separately benchmarked migration to `@huggingface/transformers` for a
  future breaking or explicitly opted-in release;
- validate output dimensions, model downloads, ONNX/WebAssembly runtimes, and
  persisted embedding compatibility before changing the default.

This is an intentional compatibility decision, not a claim that the package is
current or actively maintained.

## Publisher identity

The published package is intentionally named `@emirhanturker/projectmind`,
while the canonical source repository and GitHub owner are
`emirinnium/projectmind`. The mismatch is an npm scope/maintainer identity
choice, not a second ProjectMind repository.

The canonical metadata is kept aligned as follows:

- npm package: https://www.npmjs.com/package/@emirhanturker/projectmind
- repository: https://github.com/emirinnium/projectmind
- issues: https://github.com/emirinnium/projectmind/issues
- homepage: https://github.com/emirinnium/projectmind#readme

The npm package name and GitHub repository must not be renamed without an
explicit migration decision because that would break existing installations,
links, and MCP initialization commands.

## M8ven classification

The M8ven findings are tracked independently from this decision record:

- MCP annotations, explicit schemas, and registration contracts are MCP
  compliance improvements.
- Shell invocation review is a security-hardening item; fixed-argument
  execution is retained without shell parsing.
- The Transformers.js finding is maintenance/freshness debt with migration
  deferred for compatibility.
- The npm/GitHub identity mismatch is a metadata and reputation concern, not a
  code vulnerability.
