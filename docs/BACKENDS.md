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

The optional adapters are now available without changing the default install:

- `QdrantVectorStore` uses Qdrant's REST `points`/`points/query` API, hashes
  ProjectMind namespaces into collection names, maps arbitrary ProjectMind IDs
  to deterministic RFC 4122 UUID point IDs, preserves the original ID in a
  reserved payload field, accepts both current `{ result: { points } }` and
  legacy array query envelopes, validates vectors and limits, requires HTTPS
  for non-loopback endpoints, and accepts an injected transport for hermetic
  tests.
- `MemgraphGraphStore` uses a host-supplied Neo4j-compatible Bolt driver. It is
  read-only, bounds traversal depth/results, keeps namespace and node IDs as
  Bolt parameters, and requires graph rows to carry the
  `projectmind_namespace` property.

Neither driver nor a remote service is bundled. This keeps `npm install -g`
offline and simple; applications that opt in must supply their own credentials,
endpoint and driver. Remote adapters are asynchronous and intentionally do not
silently replace the local SQLite graph. Their descriptors and response shapes
remain explicit so a caller can report remote/freshness limitations.

Example (Qdrant):

```ts
import { QdrantVectorStore } from '@emirhanturker/projectmind';

const vectors = new QdrantVectorStore({
  endpoint: process.env.QDRANT_URL!,
  apiKey: process.env.QDRANT_API_KEY,
});
await vectors.upsert('repository/worktree/branch', 'file-id', [0.1, 0.2], {
  path: 'src/index.ts',
});
```

Memgraph connectivity remains deliberately host-owned because Memgraph speaks
Bolt and a bundled driver would add a new dependency and credential policy to
the core package. Both adapters are covered by contract and adversarial tests;
live service performance/quality must still be measured in the consumer's
deployment.
