import { z } from 'zod';
import {
  BackendDescriptorSchema,
  type AsyncGraphStore,
  type BackendDescriptor,
  type GraphEdgeRecord,
  type GraphNodeRecord,
} from './contracts.js';

const MEMGRAPH_OPTIONS_SCHEMA = z
  .object({ database: z.string().min(1).max(128).optional() })
  .strict();

export interface CypherRecordLike {
  get(key: string): unknown;
}

export interface CypherResultLike {
  records: readonly CypherRecordLike[];
}

export interface CypherSessionLike {
  run(query: string, parameters: Readonly<Record<string, unknown>>): Promise<CypherResultLike>;
  close(): Promise<void> | void;
}

export interface CypherDriverLike {
  session(options?: { database?: string }): CypherSessionLike;
}

export interface MemgraphGraphStoreOptions extends z.input<typeof MEMGRAPH_OPTIONS_SCHEMA> {
  /** A Neo4j-compatible Bolt driver supplied by the host application. */
  driver: CypherDriverLike;
}

function assertNamespace(namespace: string): void {
  if (namespace.trim().length === 0 || namespace.length > 4096 || /[\0\r\n]/u.test(namespace)) {
    throw new Error(
      'Memgraph namespace must be a non-empty bounded string without control characters.',
    );
  }
}

function assertLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Memgraph result limit must be an integer between 1 and 1,000.');
  }
  return limit;
}

function assertDepth(depth: number): number {
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > 32) {
    throw new Error('Memgraph traversal depth must be an integer between 0 and 32.');
  }
  return depth;
}

type AttributeValue = string | number | boolean | null;

function scalar(value: unknown): AttributeValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    const toNumber = (value as { toNumber?: unknown }).toNumber;
    if (typeof toNumber === 'function') {
      const converted = toNumber.call(value);
      return typeof converted === 'number' && Number.isFinite(converted) ? converted : null;
    }
  }
  return null;
}

function attributes(value: unknown): Record<string, AttributeValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, AttributeValue> = {};
  for (const [key, item] of Object.entries(value)) output[key] = scalar(item);
  return output;
}

function nodeFromRecord(record: CypherRecordLike): GraphNodeRecord {
  const id = scalar(record.get('id'));
  const kind = scalar(record.get('kind'));
  const label = scalar(record.get('label'));
  if (typeof id !== 'string' || typeof kind !== 'string' || typeof label !== 'string') {
    throw new Error('Memgraph returned a node without the required id/kind/label fields.');
  }
  return { id, kind, label, attributes: attributes(record.get('attributes')) };
}

function edgeFromRecord(record: CypherRecordLike): GraphEdgeRecord {
  const from = scalar(record.get('from'));
  const to = scalar(record.get('to'));
  const kind = scalar(record.get('kind'));
  if (typeof from !== 'string' || typeof to !== 'string' || typeof kind !== 'string') {
    throw new Error('Memgraph returned an edge without the required from/to/kind fields.');
  }
  return { from, to, kind, attributes: attributes(record.get('attributes')) };
}

/**
 * Optional read-only Memgraph adapter over its Neo4j-compatible Bolt driver.
 * ProjectMind does not bundle a Bolt driver; the host supplies one so the
 * default npm install stays offline and free of native/network dependencies.
 * The adapter reads only rows carrying the ProjectMind namespace property.
 */
export class MemgraphGraphStore implements AsyncGraphStore {
  readonly descriptor: BackendDescriptor = BackendDescriptorSchema.parse({
    id: 'memgraph-bolt',
    kind: 'graph',
    remote: true,
    credentialsRequired: true,
    capabilities: ['list-nodes', 'list-edges', 'bounded-traverse', 'namespace-filter', 'read-only'],
  });
  private readonly driver: CypherDriverLike;
  private readonly database: string | undefined;

  constructor(options: MemgraphGraphStoreOptions) {
    const { driver, ...schemaOptions } = options;
    const parsed = MEMGRAPH_OPTIONS_SCHEMA.parse(schemaOptions);
    this.driver = driver;
    this.database = parsed.database;
  }

  async listNodes(namespace: string, limit: number): Promise<readonly GraphNodeRecord[]> {
    assertNamespace(namespace);
    const result = await this.run(
      'MATCH (n {projectmind_namespace: $namespace}) RETURN n.id AS id, n.kind AS kind, n.label AS label, n.projectmind_attributes AS attributes ORDER BY id LIMIT $limit',
      { namespace, limit: assertLimit(limit) },
    );
    return result.records.map(nodeFromRecord);
  }

  async listEdges(namespace: string, limit: number): Promise<readonly GraphEdgeRecord[]> {
    assertNamespace(namespace);
    const result = await this.run(
      'MATCH (a {projectmind_namespace: $namespace})-[r]->(b {projectmind_namespace: $namespace}) RETURN a.id AS from, b.id AS to, type(r) AS kind, r.projectmind_attributes AS attributes ORDER BY from, to, kind LIMIT $limit',
      { namespace, limit: assertLimit(limit) },
    );
    return result.records.map(edgeFromRecord);
  }

  async traverse(
    namespace: string,
    startNode: string,
    depth: number,
  ): Promise<readonly GraphNodeRecord[]> {
    assertNamespace(namespace);
    if (startNode.length === 0 || startNode.length > 512 || /[\0\r\n]/u.test(startNode)) {
      throw new Error('Memgraph start node must be a bounded string without control characters.');
    }
    const safeDepth = assertDepth(depth);
    const result = await this.run(
      `MATCH (start {id: $startNode, projectmind_namespace: $namespace})-[*0..${safeDepth}]-(n {projectmind_namespace: $namespace}) RETURN DISTINCT n.id AS id, n.kind AS kind, n.label AS label, n.projectmind_attributes AS attributes ORDER BY id`,
      { namespace, startNode },
    );
    return result.records.map(nodeFromRecord);
  }

  private async run(
    query: string,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<CypherResultLike> {
    const session = this.driver.session(this.database ? { database: this.database } : undefined);
    try {
      return await session.run(query, parameters);
    } finally {
      await session.close();
    }
  }
}

export { MEMGRAPH_OPTIONS_SCHEMA as MemgraphOptionsSchema };
