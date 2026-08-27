import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { getDatabase } from '../database.js';
import { getVecIndex } from '../../core/embeddings/vector-index.js';

export interface Project {
  id: number;
  name: string;
  rootPath: string;
  description: string | null;
  createdAt: string;
  lastScanned: string;
}

/**
 * Repository for project-related database operations.
 */
export class ProjectRepository {
  constructor(private readonly db: DatabaseSync = getDatabase()) {}

  create(name: string, rootPath: string, description?: string): Project {
    const result = this.db.prepare(
      'INSERT INTO projects (name, root_path, description) VALUES (?, ?, ?)'
    ).run(name, rootPath, description || null);
    const id = Number(result.lastInsertRowid);
    return this.getById(id)!;
  }

  getById(id: number): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, SQLOutputValue> | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  getByName(name: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as Record<string, SQLOutputValue> | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  list(): Array<Project & { fileCount: number }> {
    const rows = this.db.prepare(`
      SELECT p.*, COUNT(f.id) as file_count 
      FROM projects p 
      LEFT JOIN files f ON f.project_id = p.id 
      GROUP BY p.id 
      ORDER BY p.name
    `).all() as Record<string, SQLOutputValue>[];
    return rows.map((r) => ({ ...this.mapRow(r), fileCount: (r.file_count as number) || 0 }));
  }

  delete(id: number): { success: boolean; deletedFiles: number; error?: string } {
    if (id === 1) {
      return { success: false, deletedFiles: 0, error: 'Cannot delete default project' };
    }
    const project = this.getById(id);
    if (!project) {
      return { success: false, deletedFiles: 0, error: `Project ${id} not found` };
    }
    // K9: prune vec embeddings BEFORE the files rows vanish.
    getVecIndex(this.db).removeByProject(id);
    const result = this.db.prepare('DELETE FROM files WHERE project_id = ?').run(id);
    const deletedFiles = Number(result.changes);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return { success: true, deletedFiles };
  }

  updateScanTimestamp(id: number): void {
    this.db.prepare('UPDATE projects SET last_scanned = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  }

  private mapRow(row: Record<string, SQLOutputValue>): Project {
    return {
      id: row.id as number,
      name: row.name as string,
      rootPath: row.root_path as string,
      description: (row.description as string | null) ?? null,
      createdAt: row.created_at as string,
      lastScanned: row.last_scanned as string,
    };
  }
}
