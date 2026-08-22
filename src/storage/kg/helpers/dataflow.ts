import { getStatement } from '../../database.js';
import type { KgContext } from './context.js';

export function getOrCreateResource(ctx: KgContext, qualifiedName: string, kind: string, identity: string): { id: number; qualifiedName: string; kind: string; identity: string } {
  const existing = getStatement('SELECT id FROM resources WHERE qualified_name = ?').get(qualifiedName) as { id: number } | undefined;
  if (existing) {
    return { id: existing.id, qualifiedName, kind, identity };
  }
  const result = getStatement('INSERT INTO resources (qualified_name, kind, identity) VALUES (?, ?, ?)').run(qualifiedName, kind, identity);
  return { id: Number(result.lastInsertRowid), qualifiedName, kind, identity };
}

export function recordDataFlow(ctx: KgContext, params: {
  fromResourceQualifiedName: string;
  fromResourceKind: string;
  fromResourceIdentity: string;
  toResourceQualifiedName: string;
  toResourceKind: string;
  toResourceIdentity: string;
  kind: string;
  via?: string;
  sourceFunctionName?: string;
  targetFunctionName?: string;
}): { id: number; fromResource: { id: number; qualifiedName: string; kind: string; identity: string }; toResource: { id: number; qualifiedName: string; kind: string; identity: string } } {
  const fromResource = getOrCreateResource(ctx, params.fromResourceQualifiedName, params.fromResourceKind, params.fromResourceIdentity);
  const toResource = getOrCreateResource(ctx, params.toResourceQualifiedName, params.toResourceKind, params.toResourceIdentity);

  let sourceFunctionId: number | null = null;
  let targetFunctionId: number | null = null;
  if (params.sourceFunctionName) {
    const fn = getStatement('SELECT id FROM functions WHERE name = ? LIMIT 1').get(params.sourceFunctionName) as { id: number } | undefined;
    if (fn) sourceFunctionId = fn.id;
  }
  if (params.targetFunctionName) {
    const fn = getStatement('SELECT id FROM functions WHERE name = ? LIMIT 1').get(params.targetFunctionName) as { id: number } | undefined;
    if (fn) targetFunctionId = fn.id;
  }

  const result = getStatement(`INSERT INTO data_flows (from_resource_id, to_resource_id, kind, via, source_function_id, target_function_id, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`).run(fromResource.id, toResource.id, params.kind, params.via || null, sourceFunctionId, targetFunctionId, ctx.currentProjectId);

  return {
    id: Number(result.lastInsertRowid),
    fromResource: { id: fromResource.id, qualifiedName: fromResource.qualifiedName, kind: fromResource.kind, identity: fromResource.identity },
    toResource: { id: toResource.id, qualifiedName: toResource.qualifiedName, kind: toResource.kind, identity: toResource.identity },
  };
}

export function getDataFlows(ctx: KgContext, projectId?: number): { id: number; fromResource: { id: number; qualifiedName: string; kind: string; identity: string }; toResource: { id: number; qualifiedName: string; kind: string; identity: string }; kind: string; via: string | null; sourceFunctionName: string | null; targetFunctionName: string | null }[] {
  const pid = projectId || ctx.currentProjectId;
  const rows = getStatement(`
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
  `).all(pid) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as number,
    fromResource: {
      id: r.from_resource_id as number,
      qualifiedName: r.from_qn as string,
      kind: r.from_kind as string,
      identity: r.from_identity as string,
    },
    toResource: {
      id: r.to_resource_id as number,
      qualifiedName: r.to_qn as string,
      kind: r.to_kind as string,
      identity: r.to_identity as string,
    },
    kind: r.kind as string,
    via: (r.via as string | null) ?? null,
    sourceFunctionName: (r.source_fn as string | null) ?? null,
    targetFunctionName: (r.target_fn as string | null) ?? null,
  }));
}

export function getResourceFlows(ctx: KgContext, resourceQualifiedName: string): { id: number; direction: string; resource: { id: number; qualifiedName: string; kind: string; identity: string }; kind: string; via: string | null }[] {
  const resource = getStatement('SELECT id FROM resources WHERE qualified_name = ?').get(resourceQualifiedName) as { id: number } | undefined;
  if (!resource) return [];

  const flows: { id: number; direction: string; resource: { id: number; qualifiedName: string; kind: string; identity: string }; kind: string; via: string | null }[] = [];

  const fromRows = getStatement(`
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
        kind: r.other_kind as string,
        identity: r.other_identity as string,
      },
      kind: r.kind as string,
      via: (r.via as string | null) ?? null,
    });
  }

  const toRows = getStatement(`
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
        kind: r.other_kind as string,
        identity: r.other_identity as string,
      },
      kind: r.kind as string,
      via: (r.via as string | null) ?? null,
    });
  }

  return flows;
}

export function clearDataFlows(ctx: KgContext, projectId?: number): number {
  const pid = projectId || ctx.currentProjectId;
  const result = getStatement('DELETE FROM data_flows WHERE project_id = ?').run(pid);
  return Number(result.changes);
}
