import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../database.js';

/**
 * Repository for import/dependency-related database operations.
 */
export class ImportRepository {
  constructor(private readonly db: DatabaseSync = getDatabase()) {}

  getImports(fileId: number): Array<{ id: number; source: string; kind: string; resolved: boolean; resolvedPath: string | null }> {
    const rows = this.db.prepare('SELECT * FROM imports WHERE file_id = ?').all(fileId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      source: r.source as string,
      kind: r.kind as string,
      resolved: (r.resolved as number) === 1,
      resolvedPath: (r.resolved_path as string | null) ?? null,
    }));
  }

  /**
   * Get all files that import the given file (reverse dependencies).
   */
  getDependents(fileId: number, projectId: number): Array<{ id: number; path: string; relativePath: string }> {
    const rows = this.db.prepare(`
      SELECT DISTINCT f.id, f.path, f.relative_path 
      FROM files f
      JOIN imports i ON f.id = i.file_id
      WHERE f.project_id = ? AND (
        i.source = (SELECT relative_path FROM files WHERE id = ? AND project_id = f.project_id)
        OR i.source LIKE (SELECT relative_path FROM files WHERE id = ? AND project_id = f.project_id) || '/%'
      )
    `).all(projectId, fileId, fileId) as Record<string, unknown>[];
    return rows.map((r) => ({ id: r.id as number, path: r.path as string, relativePath: r.relative_path as string }));
  }

  /**
   * Find circular dependencies in the project using DFS.
   */
  findCircularDependencies(
    allFiles: Array<{ id: number; relativePath: string }>,
    getImportsFn: (fileId: number) => Array<{ source: string }>,
    resolveImportFn: (source: string) => { id: number; relativePath: string } | null
  ): string[][] {
    const fileMap = new Map(allFiles.map((f) => [f.id, f]));
    const cycles: string[][] = [];
    const visited = new Set<number>();
    const recStack = new Map<number, number>();

    const dfs = (fileId: number, path: number[]): void => {
      if (recStack.has(fileId)) {
        const cycleStart = recStack.get(fileId)!;
        const cycle = path.slice(cycleStart).map((id) => fileMap.get(id)?.relativePath || '').filter(Boolean);
        if (cycle.length > 0) {
          cycles.push(cycle);
        }
        return;
      }
      if (visited.has(fileId)) return;

      visited.add(fileId);
      recStack.set(fileId, path.length);
      path.push(fileId);

      const imports = getImportsFn(fileId);
      for (const imp of imports) {
        const resolved = resolveImportFn(imp.source);
        if (resolved) {
          dfs(resolved.id, path);
        }
      }

      path.pop();
      recStack.delete(fileId);
    };

    for (const file of allFiles) {
      if (!visited.has(file.id)) {
        dfs(file.id, []);
      }
    }

    return this.deduplicateCycles(cycles);
  }

  /**
   * Trace all transitive imports for a file (dependency tree).
   */
  traceImports(
    fileId: number,
    getImportsFn: (fileId: number) => Array<{ source: string }>,
    resolveImportFn: (source: string) => { id: number; relativePath: string } | null,
    maxDepth: number = 10
  ): Array<{ id: number; relativePath: string; depth: number; path: string[] }> {
    const results: Array<{ id: number; relativePath: string; depth: number; path: string[] }> = [];
    const visited = new Set<number>();

    const trace = (currentFileId: number, depth: number, path: string[]): void => {
      if (depth > maxDepth || visited.has(currentFileId)) return;
      visited.add(currentFileId);

      const imports = getImportsFn(currentFileId);
      for (const imp of imports) {
        const resolved = resolveImportFn(imp.source);
        if (resolved && !visited.has(resolved.id)) {
          const newPath = [...path, imp.source];
          results.push({ id: resolved.id, relativePath: resolved.relativePath, depth: depth + 1, path: newPath });
          trace(resolved.id, depth + 1, newPath);
        }
      }
    };

    trace(fileId, 0, []);
    return results;
  }

  /**
   * Get dependency graph for a module (files in a directory and their imports).
   */
  getDependencyGraph(
    modulePath: string,
    allFiles: Array<{ id: number; relativePath: string }>,
    getImportsFn: (fileId: number) => Array<{ source: string; kind: string }>,
    resolveImportFn: (source: string) => { id: number; relativePath: string } | null
  ): { nodes: Array<{ id: number; relativePath: string }>; edges: Array<{ from: string; to: string; kind: string }> } {
    const moduleFiles = allFiles.filter((f) => f.relativePath.startsWith(modulePath));
    const moduleFileIds = new Set(moduleFiles.map((f) => f.id));

    const nodes = moduleFiles.map((f) => ({ id: f.id, relativePath: f.relativePath }));
    const edges: Array<{ from: string; to: string; kind: string }> = [];

    for (const file of moduleFiles) {
      const imports = getImportsFn(file.id);
      for (const imp of imports) {
        const resolved = resolveImportFn(imp.source);
        if (resolved && moduleFileIds.has(resolved.id)) {
          edges.push({ from: file.relativePath, to: resolved.relativePath, kind: imp.kind });
        }
      }
    }

    return { nodes, edges };
  }

  /**
   * Store circular dependencies in database.
   */
  storeCircularDependencies(cycles: string[][]): void {
    for (const cycle of cycles) {
      this.db.prepare(
        `INSERT OR IGNORE INTO circular_dependencies (cycle_path, file_count) VALUES (?, ?)`
      ).run(cycle.join(' -> '), cycle.length);
    }
  }

  private deduplicateCycles(cycles: string[][]): string[][] {
    const uniqueCycles: string[][] = [];
    for (const cycle of cycles) {
      const normalized = this.normalizeCycle(cycle);
      const isDuplicate = uniqueCycles.some((uc) => this.cyclesEqual(uc, normalized));
      if (!isDuplicate) {
        uniqueCycles.push(normalized);
      }
    }
    return uniqueCycles;
  }

  private normalizeCycle(cycle: string[]): string[] {
    let minIndex = 0;
    for (let i = 1; i < cycle.length; i++) {
      if (cycle[i] < cycle[minIndex]) minIndex = i;
    }
    return [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];
  }

  private cyclesEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}
