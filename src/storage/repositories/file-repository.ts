import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../database.js';

export interface FileRecord {
  id: number;
  projectId: number;
  path: string;
  relativePath: string;
  language: string | null;
  sizeBytes: number | null;
  hash: string | null;
  embedding: number[] | null;
  lastScanned: string;
  agentTouched: boolean;
  agentTouchedBy: string | null;
  agentTouchedAt: string | null;
  cognitiveLoad: number;
}

export interface FileAttributes {
  relativePath: string;
  language: string;
  sizeBytes: number;
  hash: string;
  embedding: number[] | null;
  cognitiveLoad: number;
}

/**
 * Repository for file-related database operations.
 */
export class FileRepository {
  constructor(private readonly db: DatabaseSync = getDatabase()) {}

  upsert(path: string, attrs: FileAttributes, projectId: number): number {
    const existing = this.db.prepare('SELECT id FROM files WHERE path = ? AND project_id = ?').get(path, projectId) as { id: number } | undefined;

    if (existing) {
      this.db.prepare(
        `UPDATE files SET relative_path = ?, language = ?, size_bytes = ?, hash = ?, embedding = ?, 
         last_scanned = CURRENT_TIMESTAMP, cognitive_load = ? WHERE id = ?`
      ).run(
        attrs.relativePath,
        attrs.language,
        attrs.sizeBytes,
        attrs.hash,
        attrs.embedding ? JSON.stringify(attrs.embedding) : null,
        attrs.cognitiveLoad,
        existing.id
      );
      return existing.id;
    } else {
      const result = this.db.prepare(
        `INSERT INTO files (project_id, path, relative_path, language, size_bytes, hash, embedding, cognitive_load)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        projectId,
        path,
        attrs.relativePath,
        attrs.language,
        attrs.sizeBytes,
        attrs.hash,
        attrs.embedding ? JSON.stringify(attrs.embedding) : null,
        attrs.cognitiveLoad
      );
      return Number(result.lastInsertRowid);
    }
  }

  getById(id: number, projectId: number): FileRecord | null {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ? AND project_id = ?').get(id, projectId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  getByPath(path: string, projectId: number): FileRecord | null {
    const normalized = path.replace(/\\/g, '/');
    const row = this.db.prepare('SELECT * FROM files WHERE (path = ? OR relative_path = ?) AND project_id = ?')
      .get(path, normalized, projectId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  getAll(projectId: number): FileRecord[] {
    const rows = this.db.prepare('SELECT * FROM files WHERE project_id = ? ORDER BY path').all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  getByLanguage(language: string, projectId: number): FileRecord[] {
    const rows = this.db.prepare('SELECT * FROM files WHERE language = ? AND project_id = ? ORDER BY last_scanned DESC')
      .all(language, projectId) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  getAgentTouched(agentName: string | undefined, projectId: number): FileRecord[] {
    if (agentName) {
      const rows = this.db.prepare('SELECT * FROM files WHERE agent_touched = 1 AND agent_touched_by = ? AND project_id = ? ORDER BY agent_touched_at DESC')
        .all(agentName, projectId) as Record<string, unknown>[];
      return rows.map((r) => this.mapRow(r));
    } else {
      const rows = this.db.prepare('SELECT * FROM files WHERE agent_touched = 1 AND project_id = ? ORDER BY agent_touched_at DESC')
        .all(projectId) as Record<string, unknown>[];
      return rows.map((r) => this.mapRow(r));
    }
  }

  getEmbedding(fileId: number): number[] | null {
    const row = this.db.prepare('SELECT embedding FROM files WHERE id = ?').get(fileId) as { embedding: string | null } | undefined;
    if (!row || !row.embedding) return null;
    try {
      return JSON.parse(row.embedding) as number[];
    } catch {
      return null;
    }
  }

  getAllEmbeddings(projectId: number): Map<number, number[]> {
    const rows = this.db.prepare('SELECT id, embedding FROM files WHERE project_id = ? AND embedding IS NOT NULL')
      .all(projectId) as Array<{ id: number; embedding: string }>;
    const map = new Map<number, number[]>();
    for (const row of rows) {
      try {
        map.set(row.id, JSON.parse(row.embedding) as number[]);
      } catch {
        // skip invalid embeddings
      }
    }
    return map;
  }

  markAgentTouched(path: string, agentName: string, projectId: number): void {
    const normalized = path.replace(/\\/g, '/');
    this.db.prepare(
      `UPDATE files SET agent_touched = 1, agent_touched_by = ?, agent_touched_at = CURRENT_TIMESTAMP 
       WHERE (path = ? OR relative_path = ?) AND project_id = ?`
    ).run(agentName, normalized, normalized, projectId);
  }

  clearFileRelations(fileId: number): void {
    this.db.prepare('DELETE FROM functions WHERE file_id = ?').run(fileId);
    this.db.prepare('DELETE FROM classes WHERE file_id = ?').run(fileId);
    this.db.prepare('DELETE FROM imports WHERE file_id = ?').run(fileId);
    this.db.prepare('DELETE FROM circular_dependencies WHERE cycle_path LIKE ?').run('%' + fileId + '%');
  }

  storeFileDetails(fileId: number, functions: Array<{
    name: string;
    signature: string;
    returnType: string;
    startLine: number;
    endLine: number;
    cyclomaticComplexity: number;
  }>, classes: Array<{
    name: string;
    signature: string;
    startLine: number;
    endLine: number;
    methodsCount: number;
    propertiesCount: number;
  }>, imports: Array<{
    source: string;
    kind: string;
  }>, _filePath: string, _projectId: number): void {
    this.clearFileRelations(fileId);
    const fnStmt = this.db.prepare(
      `INSERT INTO functions (file_id, name, signature, return_type, start_line, end_line, complexity, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const fn of functions) {
      fnStmt.run(fileId, fn.name, fn.signature, fn.returnType, fn.startLine, fn.endLine, fn.cyclomaticComplexity, null);
    }
    const clsStmt = this.db.prepare(
      `INSERT INTO classes (file_id, name, signature, start_line, end_line, methods_count, properties_count, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const cls of classes) {
      clsStmt.run(fileId, cls.name, cls.signature, cls.startLine, cls.endLine, cls.methodsCount, cls.propertiesCount, null);
    }
    const impStmt = this.db.prepare('INSERT INTO imports (file_id, source, kind, resolved, resolved_path) VALUES (?, ?, ?, ?, ?)');
    for (const imp of imports) {
      impStmt.run(fileId, imp.source, imp.kind, 0, null);
    }
  }

  private mapRow(row: Record<string, unknown>): FileRecord {
    return {
      id: row.id as number,
      projectId: row.project_id as number,
      path: row.path as string,
      relativePath: row.relative_path as string,
      language: (row.language as string | null) ?? null,
      sizeBytes: (row.size_bytes as number | null) ?? 0,
      hash: (row.hash as string | null) ?? '',
      embedding: row.embedding ? (() => { try { return JSON.parse(row.embedding as string); } catch { return null; } })() : null,
      lastScanned: row.last_scanned as string,
      agentTouched: row.agent_touched === 1,
      agentTouchedBy: (row.agent_touched_by as string | null) ?? null,
      agentTouchedAt: (row.agent_touched_at as string | null) ?? null,
      cognitiveLoad: (row.cognitive_load as number) ?? 0,
    };
  }
}
