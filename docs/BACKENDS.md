# Optional backend contracts

ProjectMind keeps SQLite/SQLite-vec as the default local backend. The runtime
contracts in `src/core/backends/contracts.ts` define the boundary for optional
GraphStore, VectorStore and ProjectIndex adapters without adding a remote
service or credential requirement to the npm install path.

Every adapter must expose a validated `BackendDescriptor` containing its kind,
local/remote status, credential requirement and capabilities. Remote adapters
must keep endpoint and credentials outside repository content and must return
the same source-backed response shape as the local implementation. A disabled
optional backend should return an actionable unsupported/provider-unavailable
error; it must not silently pretend that local data is remote or fresh.

The interfaces are contracts, not a bundled Memgraph or Qdrant implementation.
An adapter can be added later as a separate package after namespace, freshness,
credential handling and compatibility tests are available.
