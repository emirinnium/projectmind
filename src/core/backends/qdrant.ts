import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  BackendDescriptorSchema,
  type AsyncVectorStore,
  type BackendDescriptor,
  type VectorMatch,
} from './contracts.js';

const SCALAR_SCHEMA = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const PAYLOAD_SCHEMA = z.record(z.string(), SCALAR_SCHEMA);
const QDRANT_MATCH_SCHEMA = z.object({
  id: z.union([z.string(), z.number()]),
  score: z.number().finite(),
  payload: PAYLOAD_SCHEMA.optional().default({}),
});

const QDRANT_QUERY_RESPONSE_SCHEMA = z.object({
  // Qdrant's current query API wraps points in result.points. The array form
  // is retained for compatibility with older deployments and proxies.
  result: z.union([
    z.array(QDRANT_MATCH_SCHEMA),
    z.object({ points: z.array(QDRANT_MATCH_SCHEMA) }),
  ]),
});

const QDRANT_OPERATION_RESPONSE_SCHEMA = z.object({
  status: z.string().min(1),
});

/**
 * Qdrant accepts only unsigned integer or UUID point IDs. ProjectMind's
 * vector-store contract intentionally accepts arbitrary bounded string IDs,
 * so the original value is kept in a reserved payload field and the point is
 * addressed remotely by a deterministic UUID derived from it.
 */
const PROJECTMIND_ID_PAYLOAD_KEY = '__projectmind_point_id';

const QDRANT_OPTIONS_SCHEMA = z
  .object({
    endpoint: z.string().url(),
    apiKey: z.string().min(1).max(4096).optional(),
    collectionPrefix: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]{0,15}$/u)
      .default('pm_'),
    timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
  })
  .strict();

export type QdrantOptions = z.infer<typeof QDRANT_OPTIONS_SCHEMA>;

export interface RemoteHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface RemoteFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export type RemoteFetch = (url: string, init: RemoteFetchInit) => Promise<RemoteHttpResponse>;

export interface QdrantVectorStoreOptions extends z.input<typeof QDRANT_OPTIONS_SCHEMA> {
  /** Injectable transport for tests/embedders; defaults to global fetch. */
  fetch?: RemoteFetch;
}

export class RemoteBackendError extends Error {
  readonly status: number;
  readonly operation: string;

  constructor(operation: string, status: number, message: string) {
    super(`${operation} failed with HTTP ${status}: ${message}`);
    this.name = 'RemoteBackendError';
    this.status = status;
    this.operation = operation;
  }
}

function validateEndpoint(endpoint: string): URL {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== 'https:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      'Remote Qdrant endpoints must use HTTPS; plain HTTP is allowed only for loopback development servers.',
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      'Remote Qdrant endpoints must not contain credentials, query parameters, or fragments.',
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  return parsed;
}

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '[::1]' || lower === '::1';
}

function defaultRemoteFetch(url: string, init: RemoteFetchInit): Promise<RemoteHttpResponse> {
  return fetch(url, init).then((response) => ({
    ok: response.ok,
    status: response.status,
    json: () => response.json() as Promise<unknown>,
    text: () => response.text(),
  }));
}

function assertVector(vector: readonly number[]): number[] {
  if (vector.length === 0 || vector.length > 16_384) {
    throw new Error('Remote vector must contain between 1 and 16,384 dimensions.');
  }
  const copy = [...vector];
  if (copy.some((value) => !Number.isFinite(value))) {
    throw new Error('Remote vector dimensions must be finite numbers.');
  }
  return copy;
}

function assertNamespace(namespace: string): void {
  if (namespace.trim().length === 0 || namespace.length > 4096 || /[\0\r\n]/u.test(namespace)) {
    throw new Error(
      'Remote backend namespace must be a non-empty bounded string without control characters.',
    );
  }
}

function assertLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Remote vector limit must be an integer between 1 and 1,000.');
  }
  return limit;
}

function assertId(id: string): void {
  if (id.length === 0 || id.length > 512 || /[\0\r\n]/u.test(id)) {
    throw new Error('Remote vector id must be a bounded string without control characters.');
  }
}

function isNotFound(response: RemoteHttpResponse): boolean {
  return response.status === 404;
}

function collectionName(prefix: string, namespace: string): string {
  const digest = createHash('sha256').update(namespace, 'utf8').digest('hex');
  return `${prefix}${digest}`;
}

function pointId(id: string): string {
  const digest = createHash('sha256').update(id, 'utf8').digest();
  // RFC 4122 version 4/variant bits make the deterministic digest a valid
  // UUID while retaining enough entropy for the bounded contract ID space.
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function pointPayload(id: string, metadata: VectorMatch['metadata']): VectorMatch['metadata'] {
  if (Object.prototype.hasOwnProperty.call(metadata, PROJECTMIND_ID_PAYLOAD_KEY)) {
    throw new Error(
      `Remote vector metadata must not use the reserved key ${PROJECTMIND_ID_PAYLOAD_KEY}.`,
    );
  }
  return { ...metadata, [PROJECTMIND_ID_PAYLOAD_KEY]: id };
}

function publicPayload(
  payload: Record<string, string | number | boolean | null>,
): VectorMatch['metadata'] {
  const { [PROJECTMIND_ID_PAYLOAD_KEY]: _internalId, ...metadata } = payload;
  return metadata;
}

/**
 * Optional Qdrant REST adapter. It is deliberately not constructed by the
 * default CLI/MCP path: local SQLite remains offline and dependency-free.
 * Collection names are content-addressed so repository paths never become
 * remote identifiers or URL syntax.
 */
export class QdrantVectorStore implements AsyncVectorStore {
  readonly descriptor: BackendDescriptor;
  private readonly endpoint: URL;
  private readonly apiKey: string | undefined;
  private readonly collectionPrefix: string;
  private readonly timeoutMs: number;
  private readonly transport: RemoteFetch;
  private readonly dimensionsByCollection = new Map<string, number>();

  constructor(options: QdrantVectorStoreOptions) {
    const { fetch: injectedFetch, ...schemaOptions } = options;
    const parsed = QDRANT_OPTIONS_SCHEMA.parse(schemaOptions);
    this.endpoint = validateEndpoint(parsed.endpoint);
    this.apiKey = parsed.apiKey;
    this.collectionPrefix = parsed.collectionPrefix;
    this.timeoutMs = parsed.timeoutMs;
    this.transport = injectedFetch ?? defaultRemoteFetch;
    this.descriptor = BackendDescriptorSchema.parse({
      id: 'qdrant-rest',
      kind: 'vector',
      remote: true,
      credentialsRequired: Boolean(this.apiKey),
      capabilities: [
        'upsert',
        'delete',
        'nearest',
        'payload-metadata',
        'content-addressed-namespace',
      ],
    });
  }

  async upsert(
    namespace: string,
    id: string,
    vector: readonly number[],
    metadata: VectorMatch['metadata'],
  ): Promise<void> {
    assertNamespace(namespace);
    assertId(id);
    const values = assertVector(vector);
    const collection = collectionName(this.collectionPrefix, namespace);
    await this.ensureCollection(collection, values.length);
    const response = await this.request(`/collections/${encodeURIComponent(collection)}/points`, {
      method: 'PUT',
      body: JSON.stringify({
        points: [{ id: pointId(id), vector: values, payload: pointPayload(id, metadata) }],
      }),
    });
    await this.parseOperationResponse(response, 'Qdrant upsert');
  }

  async delete(namespace: string, id: string): Promise<boolean> {
    assertNamespace(namespace);
    assertId(id);
    const collection = collectionName(this.collectionPrefix, namespace);
    const response = await this.request(
      `/collections/${encodeURIComponent(collection)}/points/delete`,
      { method: 'POST', body: JSON.stringify({ points: [pointId(id)] }) },
      true,
    );
    if (isNotFound(response)) return false;
    await this.parseOperationResponse(response, 'Qdrant delete');
    return true;
  }

  async nearest(
    namespace: string,
    vector: readonly number[],
    limit: number,
  ): Promise<readonly VectorMatch[]> {
    assertNamespace(namespace);
    const values = assertVector(vector);
    const collection = collectionName(this.collectionPrefix, namespace);
    const response = await this.request(
      `/collections/${encodeURIComponent(collection)}/points/query`,
      {
        method: 'POST',
        body: JSON.stringify({ query: values, limit: assertLimit(limit), with_payload: true }),
      },
      true,
    );
    if (isNotFound(response)) return [];
    if (!response.ok) throw await this.toError('Qdrant nearest', response);
    const parsed = QDRANT_QUERY_RESPONSE_SCHEMA.parse(await response.json());
    const matches = Array.isArray(parsed.result) ? parsed.result : parsed.result.points;
    return matches.map((match) => ({
      id:
        typeof match.payload[PROJECTMIND_ID_PAYLOAD_KEY] === 'string'
          ? match.payload[PROJECTMIND_ID_PAYLOAD_KEY]
          : String(match.id),
      score: match.score,
      metadata: publicPayload(match.payload),
    }));
  }

  private async ensureCollection(collection: string, dimensions: number): Promise<void> {
    const known = this.dimensionsByCollection.get(collection);
    if (known !== undefined) {
      if (known !== dimensions) {
        throw new Error(
          `Qdrant collection dimension mismatch: expected ${known}, received ${dimensions}.`,
        );
      }
      return;
    }
    const path = `/collections/${encodeURIComponent(collection)}`;
    const existing = await this.request(path, {}, true);
    if (existing.ok) {
      this.dimensionsByCollection.set(collection, dimensions);
      return;
    }
    if (!isNotFound(existing)) {
      throw await this.toError('Qdrant collection lookup', existing);
    }
    const created = await this.request(
      path,
      {
        method: 'PUT',
        body: JSON.stringify({ vectors: { size: dimensions, distance: 'Cosine' } }),
      },
      true,
    );
    if (!created.ok && created.status !== 409)
      throw await this.toError('Qdrant collection creation', created);
    this.dimensionsByCollection.set(collection, dimensions);
  }

  private async request(
    path: string,
    init: RemoteFetchInit,
    allowErrorStatus = false,
  ): Promise<RemoteHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = new URL(this.endpoint.toString());
    url.pathname = `${this.endpoint.pathname.replace(/\/+$/u, '')}${path}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    };
    if (this.apiKey) headers['api-key'] = this.apiKey;
    try {
      const response = await this.transport(url.toString(), {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!allowErrorStatus && !response.ok) throw await this.toError('Qdrant request', response);
      return response;
    } catch (error) {
      if (error instanceof RemoteBackendError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Qdrant request timed out after ${this.timeoutMs}ms.`);
      }
      throw new Error(
        `Qdrant request could not be completed: ${error instanceof Error ? error.message : 'transport error'}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async toError(
    operation: string,
    response: RemoteHttpResponse,
  ): Promise<RemoteBackendError> {
    let detail = 'remote backend returned an error';
    try {
      const text = (await response.text())
        .replace(/[\r\n]+/gu, ' ')
        .replace(this.apiKey ?? '\u0000', '[redacted]')
        .slice(0, 240);
      if (text) detail = text;
    } catch {
      // Do not expose transport/parser failures or credentials in the public error.
    }
    return new RemoteBackendError(operation, response.status, detail);
  }

  private async parseOperationResponse(
    response: RemoteHttpResponse,
    operation: string,
  ): Promise<void> {
    // Parse the response contract even though callers do not need the
    // operation id; malformed or proxy-generated HTML must never be accepted.
    if (!response.ok)
      throw new RemoteBackendError(
        operation,
        response.status,
        'remote backend rejected the operation',
      );
    QDRANT_OPERATION_RESPONSE_SCHEMA.parse(await response.json());
  }
}

export { QDRANT_OPTIONS_SCHEMA as QdrantOptionsSchema };
