import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  QdrantVectorStore,
  type RemoteFetch,
  type RemoteHttpResponse,
} from '../../../src/core/backends/qdrant.js';
import {
  MemgraphGraphStore,
  type CypherDriverLike,
  type CypherRecordLike,
} from '../../../src/core/backends/memgraph.js';

function response(status: number, payload: unknown): RemoteHttpResponse {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => body,
  };
}

function record(values: Record<string, unknown>): CypherRecordLike {
  return { get: (key: string) => values[key] };
}

describe('optional remote backend adapters', () => {
  it('uses the current Qdrant REST collection/query contract and hashes namespaces', async () => {
    const calls: Array<{
      url: string;
      init: { method?: string; headers?: Readonly<Record<string, string>>; body?: string };
    }> = [];
    const namespace = 'C:\\checkout\\feature';
    const collection = `pm_${createHash('sha256').update(namespace, 'utf8').digest('hex')}`;
    const transport: RemoteFetch = async (url, init) => {
      calls.push({ url, init });
      if (!init.method && url.endsWith(`/collections/${collection}`)) {
        return response(404, { status: 'error' });
      }
      if (init.method === 'PUT' && url.includes('/collections/')) {
        return response(200, { status: 'ok', result: { status: 'completed' } });
      }
      if (url.includes('/points/query')) {
        return response(200, {
          result: {
            points: [{ id: 7, score: 0.91, payload: { path: 'src/auth.ts', kind: 'file' } }],
          },
          status: 'ok',
        });
      }
      return response(200, { status: 'ok', result: { status: 'completed' } });
    };

    const store = new QdrantVectorStore({
      endpoint: 'http://127.0.0.1:6333/',
      apiKey: 'secret-test-token',
      fetch: transport,
    });
    await store.upsert(namespace, 'file-7', [1, 0, 0], {
      path: 'src/auth.ts',
    });
    const nearest = await store.nearest(namespace, [1, 0, 0], 5);

    expect(nearest).toEqual([
      { id: '7', score: 0.91, metadata: { path: 'src/auth.ts', kind: 'file' } },
    ]);
    expect(calls.some((call) => call.url.includes('C:'))).toBe(false);
    expect(calls.every((call) => call.init.headers?.['api-key'] === 'secret-test-token')).toBe(
      true,
    );
    expect(calls.some((call) => call.url.includes('/points/query'))).toBe(true);
    const upsertCall = calls.find((call) => call.url.endsWith(`/collections/${collection}/points`));
    expect(upsertCall).toBeDefined();
    const upsertBody = JSON.parse(upsertCall!.init.body ?? '{}') as {
      points?: Array<{ id?: string; payload?: Record<string, unknown> }>;
    };
    expect(upsertBody.points?.[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(upsertBody.points?.[0]?.payload?.__projectmind_point_id).toBe('file-7');
    expect(store.descriptor.remote).toBe(true);
    expect(store.descriptor.kind).toBe('vector');
  });

  it('round-trips arbitrary ProjectMind IDs while hiding the reserved Qdrant payload field', async () => {
    let upsertPayload: Record<string, unknown> | undefined;
    const transport: RemoteFetch = async (url, init) => {
      if (init.method === 'PUT' && url.endsWith('/points')) {
        const parsed = JSON.parse(init.body ?? '{}') as {
          points?: Array<Record<string, unknown>>;
        };
        upsertPayload = parsed.points?.[0];
        return response(200, { status: 'ok', result: { status: 'completed' } });
      }
      if (url.includes('/points/query')) {
        return response(200, {
          result: [
            {
              id: upsertPayload?.id,
              score: 0.8,
              payload: upsertPayload?.payload,
            },
          ],
          status: 'ok',
        });
      }
      if (init.method === 'PUT') return response(200, { status: 'ok' });
      return response(404, { status: 'error' });
    };

    const store = new QdrantVectorStore({ endpoint: 'http://127.0.0.1:6333', fetch: transport });
    const originalId = 'C:\\checkout\\feature\\src\\auth.ts#symbol:login';
    await store.upsert('namespace', originalId, [1, 0], { path: 'src/auth.ts', line: 12 });
    await expect(store.nearest('namespace', [1, 0], 1)).resolves.toEqual([
      { id: originalId, score: 0.8, metadata: { path: 'src/auth.ts', line: 12 } },
    ]);
  });

  it('rejects unsafe Qdrant endpoints and invalid vectors/limits', async () => {
    expect(() => new QdrantVectorStore({ endpoint: 'http://remote.example.test:6333' })).toThrow(
      /HTTPS/u,
    );
    expect(
      () => new QdrantVectorStore({ endpoint: 'https://remote.example.test:6333?token=leak' }),
    ).toThrow(/query/u);

    const store = new QdrantVectorStore({
      endpoint: 'http://localhost:6333',
      fetch: async () => response(404, {}),
    });
    await expect(store.nearest('safe', [Number.NaN], 1)).rejects.toThrow(/finite/u);
    await expect(store.nearest('safe', [1], 0)).rejects.toThrow(/between 1 and 1,000/u);
    await expect(store.delete('safe\nnamespace', 'id')).rejects.toThrow(/control/u);
  });

  it('parses Qdrant operation responses instead of accepting malformed proxy output', async () => {
    let call = 0;
    const store = new QdrantVectorStore({
      endpoint: 'http://127.0.0.1:6333',
      fetch: async () => {
        call++;
        if (call === 1) return response(404, {});
        return response(200, '<html>not qdrant</html>');
      },
    });
    await expect(store.upsert('namespace', 'id', [1], {})).rejects.toThrow();
  });

  it('surfaces non-404 Qdrant query failures as remote backend errors', async () => {
    const store = new QdrantVectorStore({
      endpoint: 'http://127.0.0.1:6333',
      fetch: async (_url, init) => {
        if (!init.method) return response(200, { result: { status: 'green' } });
        return response(503, { status: 'error', error: 'temporarily unavailable' });
      },
    });

    await expect(store.nearest('namespace', [1], 1)).rejects.toMatchObject({
      name: 'RemoteBackendError',
      status: 503,
      operation: 'Qdrant nearest',
    });
  });

  it('keeps Memgraph namespace and user values in Bolt parameters', async () => {
    const queries: Array<{ query: string; parameters: Readonly<Record<string, unknown>> }> = [];
    const driver: CypherDriverLike = {
      session: () => ({
        run: async (query, parameters) => {
          queries.push({ query, parameters });
          if (query.includes('type(r)')) {
            return {
              records: [record({ from: 'a', to: 'b', kind: 'IMPORTS', attributes: { weight: 1 } })],
            };
          }
          return {
            records: [record({ id: 'a', kind: 'file', label: 'auth.ts', attributes: { line: 1 } })],
          };
        },
        close: () => undefined,
      }),
    };
    const store = new MemgraphGraphStore({ driver, database: 'projectmind' });
    const namespace = "C:\\checkout\\feature' OR 1=1 //";
    const nodes = await store.listNodes(namespace, 2);
    const edges = await store.listEdges(namespace, 2);
    const traversed = await store.traverse(namespace, "node' MATCH (x)", 2);

    expect(nodes[0]).toMatchObject({ id: 'a', kind: 'file', label: 'auth.ts' });
    expect(edges[0]).toMatchObject({ from: 'a', to: 'b', kind: 'IMPORTS' });
    expect(traversed[0]?.id).toBe('a');
    expect(queries.every((entry) => !entry.query.includes(namespace))).toBe(true);
    expect(queries[0]?.parameters.namespace).toBe(namespace);
    expect(queries[2]?.parameters.startNode).toBe("node' MATCH (x)");
    expect(store.descriptor.credentialsRequired).toBe(true);
  });

  it('bounds Memgraph traversal and result sizes before touching the driver', async () => {
    let calls = 0;
    const driver: CypherDriverLike = {
      session: () => ({
        run: async () => {
          calls++;
          return { records: [] };
        },
        close: () => undefined,
      }),
    };
    const store = new MemgraphGraphStore({ driver });
    await expect(store.listNodes('ns', 0)).rejects.toThrow(/between 1 and 1,000/u);
    await expect(store.traverse('ns', 'node', 33)).rejects.toThrow(/between 0 and 32/u);
    expect(calls).toBe(0);
  });
});
