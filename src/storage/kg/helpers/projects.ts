import type { SQLOutputValue } from 'node:sqlite';
import type { KgContext } from './context.js';
import { getVecIndex } from '../../../core/embeddings/vector-index.js';

export function ensureDefaultProject(ctx: KgContext): void {
  const existing = ctx.db.prepare('SELECT id FROM projects WHERE id = 1').get() as { id: number } | undefined;
  if (!existing) {
    ctx.db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(1, 'default', process.cwd());
  }
}

export function loadCurrentProjectId(ctx: KgContext): number {
  try {
    const row = ctx.db.prepare("SELECT value FROM settings WHERE key = 'current_project_id'").get() as { value: string } | undefined;
    if (row) {
      const parsed = parseInt(row.value, 10);
      // Guard: a persisted id whose project row is gone (e.g. deleted via
      // another connection) must fall back to the default project instead
      // of silently emptying every file query.
      if (!Number.isNaN(parsed) && parsed > 0) {
        const exists = ctx.db.prepare('SELECT id FROM projects WHERE id = ?').get(parsed);
        if (exists) return parsed;
      }
    }
  } catch {
    // settings table may not exist yet in older databases
  }
  return ctx.currentProjectId;
}

export function persistCurrentProjectId(ctx: KgContext): void {
  try {
    ctx.db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('current_project_id', ?, CURRENT_TIMESTAMP)").run(String(ctx.currentProjectId));
  } catch {
    // ignore persistence errors
  }
}

export function createProject(ctx: KgContext, name: string, rootPath: string, description?: string): { id: number; name: string; rootPath: string } {
  const result = ctx.db.prepare('INSERT INTO projects (name, root_path, description) VALUES (?, ?, ?)').run(name, rootPath, description || null);
  const id = Number(result.lastInsertRowid);
  return { id, name, rootPath };
}

export function getProject(ctx: KgContext, id: number): { id: number; name: string; rootPath: string; description: string | null; createdAt: string; lastScanned: string } | null {
  const row = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, SQLOutputValue> | undefined;
  if (!row) return null;
  return {
    id: row.id as number,
    name: row.name as string,
    rootPath: row.root_path as string,
    description: (row.description as string | null) ?? null,
    createdAt: row.created_at as string,
    lastScanned: row.last_scanned as string,
  };
}

export function getProjectByName(ctx: KgContext, name: string): { id: number; name: string; rootPath: string; description: string | null; createdAt: string; lastScanned: string } | null {
  const row = ctx.db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as Record<string, SQLOutputValue> | undefined;
  if (!row) return null;
  return {
    id: row.id as number,
    name: row.name as string,
    rootPath: row.root_path as string,
    description: (row.description as string | null) ?? null,
    createdAt: row.created_at as string,
    lastScanned: row.last_scanned as string,
  };
}

export function listProjects(ctx: KgContext): { id: number; name: string; rootPath: string; fileCount: number; lastScanned: string }[] {
  const rows = ctx.db.prepare(`
    SELECT p.*, COUNT(f.id) as file_count 
    FROM projects p 
    LEFT JOIN files f ON f.project_id = p.id 
    GROUP BY p.id 
    ORDER BY p.name
  `).all() as Record<string, SQLOutputValue>[];
  return rows.map((r) => ({
    id: r.id as number,
    name: r.name as string,
    rootPath: r.root_path as string,
    fileCount: (r.file_count as number) || 0,
    lastScanned: r.last_scanned as string,
  }));
}

export function deleteProject(ctx: KgContext, projectId: number): { success: boolean; deletedFiles: number; error?: string } {
  if (projectId === 1) {
    return { success: false, deletedFiles: 0, error: 'Cannot delete default project' };
  }
  const project = getProject(ctx, projectId);
  if (!project) {
    return { success: false, deletedFiles: 0, error: `Project ${projectId} not found` };
  }
  // K9: prune vec embeddings BEFORE the files rows vanish (removeByProject
  // joins back to `files` to find candidate rowids).
  getVecIndex(ctx.db).removeByProject(projectId);

  const result = ctx.db.prepare('DELETE FROM files WHERE project_id = ?').run(projectId);
  const deletedFiles = Number(result.changes);
  ctx.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

  // If the deleted project was active, fall back to the default project so
  // subsequent queries don't run against a dangling id.
  if (ctx.currentProjectId === projectId || loadCurrentProjectId(ctx) === projectId) {
    ctx.currentProjectId = 1;
    persistCurrentProjectId(ctx);
  }

  return { success: true, deletedFiles };
}
