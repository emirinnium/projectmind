import type { SQLOutputValue } from 'node:sqlite';

import { getProjectIgnorePatterns, isIgnoredRelativePath } from '../../../utils/ignore.js';

import type { FileInfo } from '../types.js';

import type { KgContext } from './context.js';

export function mapFileInfo(row: Record<string, SQLOutputValue>): FileInfo {
  return {
    id: row.id as number,
    path: row.path as string,
    relativePath: row.relative_path as string,
    language: row.language as string,
    sizeBytes: row.size_bytes as number,
    hash: row.hash as string,
    agentTouched: row.agent_touched === 1,
    agentTouchedBy: (row.agent_touched_by as string | null) ?? null,
    agentTouchedAt: (row.agent_touched_at as string | null) ?? null,
    cognitiveLoad: (row.cognitive_load as number) ?? 0,
    lastScanned: row.last_scanned as string,
    lastSynced: (row.last_synced as string) ?? (row.last_scanned as string),
    patterns: JSON.parse((row.patterns as string) ?? '[]') as string[],
  };
}

function visibleToProject(ctx: KgContext, file: FileInfo): boolean {
  return (
    !ctx.projectRoot ||
    !isIgnoredRelativePath(file.relativePath, getProjectIgnorePatterns(ctx.projectRoot))
  );
}

export function getFileByPath(ctx: KgContext, path: string, projectId?: number): FileInfo | null {
  const normalized = path.replace(/\\/g, '/');
  const pid = projectId ?? ctx.currentProjectId;
  const lookups: Array<[string, string]> = [
    ['SELECT * FROM files WHERE path = ? AND project_id = ?', path],
    ['SELECT * FROM files WHERE path = ? AND project_id = ?', normalized],
    ['SELECT * FROM files WHERE relative_path = ? AND project_id = ?', normalized],
    ['SELECT * FROM files WHERE relative_path = ? COLLATE NOCASE AND project_id = ?', normalized],
    ['SELECT * FROM files WHERE path = ? COLLATE NOCASE AND project_id = ?', normalized],
  ];
  for (const [sql, value] of lookups) {
    const row = ctx.db.prepare(sql).get(value, pid) as Record<string, SQLOutputValue> | undefined;
    if (row) {
      const file = mapFileInfo(row);
      if (visibleToProject(ctx, file)) return file;
    }
  }
  return null;
}

export function getFileById(ctx: KgContext, fileId: number, projectId?: number): FileInfo | null {
  const pid = projectId ?? ctx.currentProjectId;
  const row = ctx.db
    .prepare('SELECT * FROM files WHERE id = ? AND project_id = ?')
    .get(fileId, pid) as Record<string, SQLOutputValue> | undefined;
  if (!row) return null;
  const file = mapFileInfo(row);
  return visibleToProject(ctx, file) ? file : null;
}

export function getFilesByLanguage(
  ctx: KgContext,
  language: string,
  projectId?: number,
): FileInfo[] {
  const pid = projectId ?? ctx.currentProjectId;
  const rows = ctx.db
    .prepare('SELECT * FROM files WHERE language = ? AND project_id = ? ORDER BY last_scanned DESC')
    .all(language, pid) as Record<string, SQLOutputValue>[];
  return rows.map((row) => mapFileInfo(row)).filter((file) => visibleToProject(ctx, file));
}

export function getAllFiles(ctx: KgContext, projectId?: number): FileInfo[] {
  const pid = projectId ?? ctx.currentProjectId;
  const rows = ctx.db
    .prepare('SELECT * FROM files WHERE project_id = ? ORDER BY path')
    .all(pid) as Record<string, SQLOutputValue>[];
  return rows.map((row) => mapFileInfo(row)).filter((file) => visibleToProject(ctx, file));
}

export function getAgentTouchedFiles(
  ctx: KgContext,
  agentName?: string,
  projectId?: number,
): FileInfo[] {
  const pid = projectId ?? ctx.currentProjectId;
  const sql = agentName
    ? 'SELECT * FROM files WHERE agent_touched = 1 AND agent_touched_by = ? AND project_id = ? ORDER BY agent_touched_at DESC'
    : 'SELECT * FROM files WHERE agent_touched = 1 AND project_id = ? ORDER BY agent_touched_at DESC';
  const rows = (
    agentName ? ctx.db.prepare(sql).all(agentName, pid) : ctx.db.prepare(sql).all(pid)
  ) as Record<string, SQLOutputValue>[];
  return rows.map((row) => mapFileInfo(row)).filter((file) => visibleToProject(ctx, file));
}
