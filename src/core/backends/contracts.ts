import { z } from 'zod';

export const BackendKindSchema = z.enum(['graph', 'vector', 'project-index']);

export const BackendDescriptorSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    kind: BackendKindSchema,
    remote: z.boolean(),
    credentialsRequired: z.boolean(),
    capabilities: z.array(z.string().min(1).max(100)).max(50),
  })
  .strict();

export type BackendKind = z.infer<typeof BackendKindSchema>;
export type BackendDescriptor = z.infer<typeof BackendDescriptorSchema>;

export interface GraphNodeRecord {
  id: string;
  kind: string;
  label: string;
  attributes: Record<string, string | number | boolean | null>;
}

export interface GraphEdgeRecord {
  from: string;
  to: string;
  kind: string;
  attributes: Record<string, string | number | boolean | null>;
}

export interface GraphStore {
  readonly descriptor: BackendDescriptor;
  listNodes(namespace: string, limit: number): readonly GraphNodeRecord[];
  listEdges(namespace: string, limit: number): readonly GraphEdgeRecord[];
  traverse(namespace: string, startNode: string, depth: number): readonly GraphNodeRecord[];
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata: Record<string, string | number | boolean | null>;
}

export interface VectorStore {
  readonly descriptor: BackendDescriptor;
  upsert(
    namespace: string,
    id: string,
    vector: readonly number[],
    metadata: VectorMatch['metadata'],
  ): void;
  delete(namespace: string, id: string): boolean;
  nearest(namespace: string, vector: readonly number[], limit: number): readonly VectorMatch[];
}

export interface ProjectFreshness {
  namespace: string;
  sourceHash: string;
  scannedAt: string;
  stale: boolean;
}

export interface ProjectIndex {
  readonly descriptor: BackendDescriptor;
  getFreshness(namespace: string, relativePath: string): ProjectFreshness | undefined;
  invalidate(namespace: string, relativePaths: readonly string[]): number;
}

export function parseBackendDescriptor(raw: unknown): BackendDescriptor {
  return BackendDescriptorSchema.parse(raw);
}
