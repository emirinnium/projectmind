import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../database.js';

export type ResourceKind = 'FILE' | 'NETWORK' | 'DATABASE' | 'ENV' | 'STDIN' | 'STDOUT' | 'STDERR' | 'SOCKET';
export type DataFlowKind = 'resource' | 'arg' | 'return';

export interface Resource {
  id: number;
  qualifiedName: string;
  kind: ResourceKind;
  identity: string;
}

export interface DataFlowEntry {
  id: number;
  fromResource: Resource;
  toResource: Resource;
  kind: DataFlowKind;
  via: string | null;
  sourceFunctionName: string | null;
  targetFunctionName: string | null;
}

/**
 * Repository for data-flow and taint analysis operations.
 */
export class DataFlowRepository {
  constructor(private readonly db: DatabaseSync = getDatabase()) {}

  getOrCreateResource(qualifiedName: string, kind: ResourceKind, identity: string): Resource {
    const existing = this.db.prepare('SELECT id FROM resources WHERE qualified_name = ?').get(qualifiedName) as { id: number } | undefined;
    if (existing) {
      return { id: existing.id, qualifiedName, kind, identity };
    }
    const result = this.db.prepare('INSERT INTO resources (qualified_name, kind, identity) VALUES (?, ?, ?)').run(qualifiedName, kind, identity);
    return { id: Number(result.lastInsertRowid), qualifiedName, kind, identity };
  }

  recordFlow(params: {
    fromResourceQualifiedName: string;
    fromResourceKind: ResourceKind;
    fromResourceIdentity: string;
    toResourceQualifiedName: string;
    toResourceKind: ResourceKind;
    toResourceIdentity: string;
    kind: DataFlowKind;
    via?: string;
    sourceFunctionName?: string;
    targetFunctionName?: string;
    projectId: number;
  }): DataFlowEntry {
    const fromResource = this.getOrCreateResource(params.fromResourceQualifiedName, params.fromResourceKind, params.fromResourceIdentity);
    const toResource = this.getOrCreateResource(params.toResourceQualifiedName, params.toResourceKind, params.toResourceIdentity);

    const sourceFunctionId = this.resolveFunctionId(params.sourceFunctionName);
    const targetFunctionId = this.resolveFunctionId(params.targetFunctionName);

    const result = this.db.prepare(
      `INSERT INTO data_flows (from_resource_id, to_resource_id, kind, via, source_function_id, target_function_id, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(fromResource.id, toResource.id, params.kind, params.via || null, sourceFunctionId, targetFunctionId, params.projectId);

    return {
      id: Number(result.lastInsertRowid),
      fromResource,
      toResource,
      kind: params.kind,
      via: params.via || null,
      sourceFunctionName: params.sourceFunctionName || null,
      targetFunctionName: params.targetFunctionName || null,
    };
  }

  getFlows(projectId: number): DataFlowEntry[] {
    const rows = this.db.prepare(`
      SELECT df.*, 
        r1.qualified_name as from_qn, r1.kind as from_kind, r1.identity as from_identity,
        r2.qualified_name as to_qn, r2.kind as to_kind, r2.identity as to_identity,
        f1.name as source_fn, f2.name as target_fn
      FROM data_flows df
      JOIN resources r1 ON df.from_resource_id = r1.id
      JOIN resources r2 ON df.to_resource_id = r2.id
      LEFT JOIN functions f1 ON df.source_function_id = f1.id
      LEFT JOIN functions f2 ON df.target_function_id = f2.id
      WHERE df.project_id = ?
      ORDER BY df.detected_at DESC
    `).all(projectId) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: r.id as number,
      fromResource: {
        id: r.from_resource_id as number,
        qualifiedName: r.from_qn as string,
        kind: r.from_kind as ResourceKind,
        identity: r.from_identity as string,
      },
      toResource: {
        id: r.to_resource_id as number,
        qualifiedName: r.to_qn as string,
        kind: r.to_kind as ResourceKind,
        identity: r.to_identity as string,
      },
      kind: r.kind as DataFlowKind,
      via: (r.via as string | null) ?? null,
      sourceFunctionName: (r.source_fn as string | null) ?? null,
      targetFunctionName: (r.target_fn as string | null) ?? null,
    }));
  }

  getResourceFlows(resourceQualifiedName: string): Array<{
    id: number;
    direction: 'from' | 'to';
    resource: Resource;
    kind: DataFlowKind;
    via: string | null;
  }> {
    const resource = this.db.prepare('SELECT id FROM resources WHERE qualified_name = ?').get(resourceQualifiedName) as { id: number } | undefined;
    if (!resource) return [];

    const flows: Array<{
      id: number;
      direction: 'from' | 'to';
      resource: Resource;
      kind: DataFlowKind;
      via: string | null;
    }> = [];

    const fromRows = this.db.prepare(`
      SELECT df.*, r2.qualified_name as other_qn, r2.kind as other_kind, r2.identity as other_identity
      FROM data_flows df
      JOIN resources r2 ON df.to_resource_id = r2.id
      WHERE df.from_resource_id = ?
    `).all(resource.id) as Record<string, unknown>[];

    for (const r of fromRows) {
      flows.push({
        id: r.id as number,
        direction: 'from',
        resource: {
          id: r.to_resource_id as number,
          qualifiedName: r.other_qn as string,
          kind: r.other_kind as ResourceKind,
          identity: r.other_identity as string,
        },
        kind: r.kind as DataFlowKind,
        via: (r.via as string | null) ?? null,
      });
    }

    const toRows = this.db.prepare(`
      SELECT df.*, r1.qualified_name as other_qn, r1.kind as other_kind, r1.identity as other_identity
      FROM data_flows df
      JOIN resources r1 ON df.from_resource_id = r1.id
      WHERE df.to_resource_id = ?
    `).all(resource.id) as Record<string, unknown>[];

    for (const r of toRows) {
      flows.push({
        id: r.id as number,
        direction: 'to',
        resource: {
          id: r.from_resource_id as number,
          qualifiedName: r.other_qn as string,
          kind: r.other_kind as ResourceKind,
          identity: r.other_identity as string,
        },
        kind: r.kind as DataFlowKind,
        via: (r.via as string | null) ?? null,
      });
    }

    return flows;
  }

  clearFlows(projectId: number): number {
    const result = this.db.prepare('DELETE FROM data_flows WHERE project_id = ?').run(projectId);
    return Number(result.changes);
  }

  private resolveFunctionId(functionName?: string): number | null {
    if (!functionName) return null;
    const fn = this.db.prepare('SELECT id FROM functions WHERE name = ? LIMIT 1').get(functionName) as { id: number } | undefined;
    return fn?.id ?? null;
  }
}
