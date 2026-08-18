import { DatabaseSync } from 'node:sqlite';
import { getDatabase, getStatement, runWithRetry } from '../database.js';
import { SCHEMA_SQL } from '../schema.js';
import { FileStructure } from '../../parser/ast-parser.js';
import { codeToEmbedding, cosineSimilarity } from '../../parser/embeddings.js';
import type { FileInfo, MemoryEntry, AgentSession } from './types.js';
import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../../utils/config.js';

export class KnowledgeGraph {
  readonly db: DatabaseSync;

  constructor(db?: DatabaseSync) {
    this.db = db ?? getDatabase();
    this.db.exec(SCHEMA_SQL);
  }

  // ... existing methods ...

  async upsertFile(fileStruct: FileStructure, relativePath: string): Promise<number> {
    const embedding = codeToEmbedding(fileStruct.functions.map((f) => f.signature).join('\n'));
    const embeddingJson = JSON.stringify(embedding);
    const cognitiveLoad = this.calculateCognitiveLoad(fileStruct);

    return runWithRetry(async () => {
      const existing = getStatement('SELECT id FROM files WHERE path = ?').get(fileStruct.filePath) as { id: number } | undefined;

      if (existing) {
        getStatement(
          `UPDATE files SET relative_path = ?, language = ?, size_bytes = ?, hash = ?, embedding = ?, 
           last_scanned = CURRENT_TIMESTAMP, cognitive_load = ? WHERE id = ?`
        ).run(
          relativePath,
          fileStruct.language,
          fileStruct.sizeBytes,
          fileStruct.hash,
          embeddingJson,
          cognitiveLoad,
          existing.id
        );
        this.clearFileRelations(existing.id);
        return existing.id;
      } else {
        const result = getStatement(
          `INSERT INTO files (path, relative_path, language, size_bytes, hash, embedding, cognitive_load)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          fileStruct.filePath,
          relativePath,
          fileStruct.language,
          fileStruct.sizeBytes,
          fileStruct.hash,
          embeddingJson,
          cognitiveLoad
        );
        return Number(result.lastInsertRowid);
      }
    });
  }

  private clearFileRelations(fileId: number): void {
    getStatement('DELETE FROM functions WHERE file_id = ?').run(fileId);
    getStatement('DELETE FROM classes WHERE file_id = ?').run(fileId);
    getStatement('DELETE FROM imports WHERE file_id = ?').run(fileId);
    getStatement('DELETE FROM circular_dependencies WHERE cycle_path LIKE ?').run('%' + fileId + '%');
  }

  /**
   * Batch-insert all functions, classes, and imports for a file in a single
   * transaction.  Replaces N+1 individual INSERT statements with one
   * batch, cutting DB round-trips by ~90%.
   *
   * Uses SAVEPOINT so it is safe to call from within an outer transaction
   * (e.g. scanProject) — SQLite does not allow nested BEGIN/COMMIT blocks,
   * but SAVEPOINT works correctly inside an existing transaction.
   */
  storeFileDetails(fileId: number, fileStruct: FileStructure): void {
    runWithRetry(async () => {
      this.db.exec('SAVEPOINT storeFileDetails');
      try {
        const fnStmt = getStatement(
          `INSERT INTO functions (file_id, name, signature, return_type, start_line, end_line, complexity, embedding)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const fn of fileStruct.functions) {
          fnStmt.run(
            fileId,
            fn.name,
            fn.signature,
            fn.returnType,
            fn.startLine,
            fn.endLine,
            fn.cyclomaticComplexity,
            JSON.stringify(codeToEmbedding(fn.signature))
          );
        }

        const clsStmt = getStatement(
          `INSERT INTO classes (file_id, name, signature, start_line, end_line, methods_count, properties_count, embedding)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const cls of fileStruct.classes) {
          clsStmt.run(
            fileId,
            cls.name,
            cls.signature,
            cls.startLine,
            cls.endLine,
            cls.methodsCount,
            cls.propertiesCount,
            JSON.stringify(codeToEmbedding(cls.signature))
          );
        }

        const impStmt = getStatement(`INSERT INTO imports (file_id, source, kind, resolved, resolved_path) VALUES (?, ?, ?, ?, ?)`);
        const fromFile = this.getFileByPath(fileStruct.filePath);
        const fromDir = fromFile ? dirname(fromFile.relativePath).replace(/\\/g, '/') : '';
        
        // Load path aliases from tsconfig - use project root
        const config = loadConfig();
        const projectRoot = config.projectRoot;
        
        let aliases: { prefix: string; paths: string[] }[] = [];
        const tsconfigFile = this.getFileByPath('tsconfig.json');
        if (tsconfigFile) {
          try {
            const content = readFileSync(tsconfigFile.path, 'utf-8');
            const tsconfig = JSON.parse(content);
            if (tsconfig.compilerOptions?.paths) {
              for (const [prefix, paths] of Object.entries(tsconfig.compilerOptions.paths)) {
                aliases.push({
                  prefix: prefix.replace(/\*$/, ''),
                  paths: (paths as string[]).map(p => p.replace(/\*$/, '')),
                });
              }
            }
          } catch {
            // ignore
          }
        }
        
        for (const imp of fileStruct.imports) {
          let resolved = false;
          let resolvedPath: string | null = null;
          
          // Try alias resolution first (for @/... style imports)
          for (const alias of aliases) {
            if (imp.source.startsWith(alias.prefix)) {
              const remainder = imp.source.slice(alias.prefix.length);
              for (const targetPath of alias.paths) {
                // Use project root for alias resolution
                const candidate = resolve(projectRoot, targetPath + remainder).replace(/\\/g, '/');
                const found = this.resolveImportSource(candidate);
                if (found) {
                  resolved = true;
                  resolvedPath = found.relativePath;
                  break;
                }
              }
              if (resolved) break;
            }
          }
          
          // If not resolved via alias, try direct resolution
          if (!resolved) {
            const found = this.resolveImportSource(imp.source, fromDir);
            if (found) {
              resolved = true;
              resolvedPath = found.relativePath;
            }
          }
          
          impStmt.run(fileId, imp.source, imp.kind, resolved ? 1 : 0, resolvedPath);
        }

        this.db.exec('RELEASE SAVEPOINT storeFileDetails');
      } catch (e) {
        this.db.exec('ROLLBACK TO SAVEPOINT storeFileDetails');
        throw e;
      }
    }, {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 1000,
      retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'database is locked'],
    });
  }

  private calculateCognitiveLoad(fileStruct: FileStructure): number {
    const complexityScore = fileStruct.functions.reduce(
      (sum: number, fn: { cyclomaticComplexity: number }) => sum + fn.cyclomaticComplexity, 0
    );
    const importCount = fileStruct.imports.length;
    const functionCount = fileStruct.functions.length;
    return (complexityScore * 0.5 + importCount * 0.3 + functionCount * 0.2) / 100;
  }

  markAgentTouched(filePath: string, agentName: string): void {
    runWithRetry(async () => {
      const normalized = filePath.replace(/\\/g, '/');
      getStatement(
        `UPDATE files SET agent_touched = 1, agent_touched_by = ?, agent_touched_at = CURRENT_TIMESTAMP 
         WHERE path = ? OR relative_path = ?`
      ).run(agentName, normalized, normalized);
    });
  }

  getFileByPath(path: string): FileInfo | null {
    const normalized = path.replace(/\\/g, '/');
    const row = getStatement('SELECT * FROM files WHERE path = ? OR relative_path = ? OR relative_path = ?')
      .get(path, normalized, path.replace(/\//g, '\\')) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapFileInfo(row);
  }

  getFilesByLanguage(language: string): FileInfo[] {
    const rows = getStatement('SELECT * FROM files WHERE language = ? ORDER BY last_scanned DESC')
      .all(language) as Record<string, unknown>[];
    return rows.map((r) => this.mapFileInfo(r));
  }

  getAllFiles(): FileInfo[] {
    const rows = getStatement('SELECT * FROM files ORDER BY path').all() as Record<string, unknown>[];
    return rows.map((r) => this.mapFileInfo(r));
  }

  getAgentTouchedFiles(agentName?: string): FileInfo[] {
    const sql = agentName
      ? 'SELECT * FROM files WHERE agent_touched = 1 AND agent_touched_by = ? ORDER BY agent_touched_at DESC'
      : 'SELECT * FROM files WHERE agent_touched = 1 ORDER BY agent_touched_at DESC';
    const rows = (agentName
      ? getStatement(sql).all(agentName)
      : getStatement(sql).all()
    ) as Record<string, unknown>[];
    return rows.map((r) => this.mapFileInfo(r));
  }

  /**
   * Fixed N+1 query: fetch all embeddings in a single SELECT instead of
   * one query per candidate file.
   */
  findSimilarFiles(targetEmbedding: number[], threshold = 0.7, limit = 10): FileInfo[] {
    if (targetEmbedding.length === 0) {
      const allFiles = this.getAllFiles();
      return allFiles.slice(0, limit);
    }

    const allFiles = this.getAllFiles();

    // Single batch query for all embeddings
    const ids = allFiles.map((f) => f.id);
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const rows = getStatement(`SELECT id, embedding FROM files WHERE id IN (${placeholders})`)
      .all(...ids) as { id: number; embedding: string | null }[];

    const embeddingMap = new Map<number, number[]>();
    for (const row of rows) {
      if (!row.embedding) continue;
      try {
        embeddingMap.set(row.id, JSON.parse(row.embedding) as number[]);
      } catch {
        // skip invalid embeddings
      }
    }

    const candidates: { id: number; embedding: number[] }[] = [];
    for (const file of allFiles) {
      const emb = embeddingMap.get(file.id);
      if (emb) candidates.push({ id: file.id, embedding: emb });
    }

    const matches = findSimilarIn(targetEmbedding, candidates, threshold, limit);
    const matchIds = matches.map((m) => m.id);
    if (matchIds.length === 0) return [];

    const matchPlaceholders = matchIds.map(() => '?').join(',');
    const resultRows = getStatement(`SELECT * FROM files WHERE id IN (${matchPlaceholders})`)
      .all(...matchIds) as Record<string, unknown>[];
    return resultRows.map((r) => this.mapFileInfo(r));
  }

  getFunctions(fileId: number): unknown[] {
    return getStatement('SELECT * FROM functions WHERE file_id = ?').all(fileId) as unknown[];
  }

  getClasses(fileId: number): unknown[] {
    return getStatement('SELECT * FROM classes WHERE file_id = ?').all(fileId) as unknown[];
  }

  getImports(fileId: number): { source: string; named: string[]; kind: string }[] {
    const rows = getStatement('SELECT * FROM imports WHERE file_id = ?').all(fileId) as Record<string, unknown>[];
    return rows.map((r) => ({
      source: r.source as string,
      named: [],
      kind: r.kind as string,
    }));
  }

  getFileEmbedding(fileId: number): number[] | null {
    const row = getStatement('SELECT embedding FROM files WHERE id = ?').get(fileId) as { embedding: string | null } | undefined;
    if (!row || !row.embedding) return null;
    try {
      return JSON.parse(row.embedding) as number[];
    } catch {
      return null;
    }
  }

  startAgentSession(agentName: string): number {
    const result = getStatement('INSERT INTO agent_sessions (agent_name) VALUES (?)').run(agentName);
    return Number(result.lastInsertRowid);
  }

  endAgentSession(sessionId: number): void {
    getStatement(
      'UPDATE agent_sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(sessionId);
  }

  storeMemory(sessionId: number, scope: string, key: string, value: string): void {
    getStatement(
      `INSERT INTO agent_memory (session_id, scope, key, value) VALUES (?, ?, ?, ?)`
    ).run(sessionId, scope, key, value);
  }

  getMemory(scope: string, key?: string): MemoryEntry[] {
    const sql = key
      ? 'SELECT * FROM agent_memory WHERE scope = ? AND key = ? ORDER BY created_at DESC'
      : 'SELECT * FROM agent_memory WHERE scope = ? ORDER BY created_at DESC';
    const rows = (key
      ? getStatement(sql).all(scope, key)
      : getStatement(sql).all(scope)
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      sessionId: r.session_id as number,
      scope: r.scope as string,
      key: r.key as string,
      value: this.tryParseJson(r.value as string),
      createdAt: r.created_at as string,
    }));
  }

  private tryParseJson(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  getAgentSessions(agentName?: string, limit: number = 50): AgentSession[] {
    const sql = agentName
      ? 'SELECT * FROM agent_sessions WHERE agent_name = ? ORDER BY started_at DESC LIMIT ?'
      : 'SELECT * FROM agent_sessions ORDER BY started_at DESC LIMIT ?';
    const rows = (agentName
      ? getStatement(sql).all(agentName, limit)
      : getStatement(sql).all(limit)
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      agentName: r.agent_name as string,
      startedAt: r.started_at as string,
      endedAt: r.ended_at as string | null,
      contextHash: r.context_hash as string,
      decisions: r.decisions ? JSON.parse(r.decisions as string) : null,
      fingerprint: r.fingerprint ? JSON.parse(r.fingerprint as string) : null,
    }));
  }

  // ===== Import/Dependency Analysis Methods =====

  /**
   * Get all files that import the given file (reverse dependencies)
   */
  getDependents(fileId: number): FileInfo[] {
    const rows = getStatement(`
      SELECT DISTINCT f.* FROM files f
      JOIN imports i ON f.id = i.file_id
      WHERE i.source = (SELECT relative_path FROM files WHERE id = ?)
         OR i.source LIKE (SELECT relative_path FROM files WHERE id = ?) || '/%'
    `).all(fileId, fileId) as Record<string, unknown>[];
    return rows.map((r) => this.mapFileInfo(r));
  }

  /**
   * Get all files that directly import a specific source
   */
  getDirectDependents(sourcePath: string): FileInfo[] {
    const normalizedSource = sourcePath.replace(/\\/g, '/');
    const rows = getStatement(`
      SELECT DISTINCT f.* FROM files f
      JOIN imports i ON f.id = i.file_id
      WHERE i.source = ? OR i.source LIKE ? || '/%'
    `).all(normalizedSource, normalizedSource) as Record<string, unknown>[];
    return rows.map((r) => this.mapFileInfo(r));
  }

  /**
   * Get imports for a file with full file info
   */
  getImportsWithDetails(fileId: number): { source: string; kind: string; resolvedFile: FileInfo | null }[] {
    const imports = this.getImports(fileId);
    return imports.map((imp) => ({
      ...imp,
      resolvedFile: this.resolveImportSource(imp.source),
    }));
  }

  /**
   * Resolve an import source to a file in the knowledge graph
   */
  resolveImportSource(source: string, fromDir?: string): FileInfo | null {
    // Handle relative imports (./ or ../)
    let searchPath = source;
    if (fromDir && (source.startsWith('./') || source.startsWith('../'))) {
      searchPath = resolve(fromDir, source).replace(/\\/g, '/');
      // Normalize to relative path from project root
      const config = loadConfig();
      const projectRoot = config.projectRoot.replace(/\\/g, '/');
      if (searchPath.startsWith(projectRoot)) {
        searchPath = searchPath.slice(projectRoot.length + 1);
      }
    }
    
    // Convert .js/.jsx/.mjs/.cjs extensions to .ts/.tsx for source file lookup
    const jsExtensions = ['.js', '.jsx', '.mjs', '.cjs'];
    const tsExtensions = ['.ts', '.tsx', '.ts', '.ts'];
    for (let i = 0; i < jsExtensions.length; i++) {
      if (searchPath.endsWith(jsExtensions[i])) {
        searchPath = searchPath.slice(0, -jsExtensions[i].length) + tsExtensions[i];
        break;
      }
    }
    
    // Try exact match first
    let file = this.getFileByPath(searchPath);
    if (file) return file;
    
    // Try with index files (e.g., src/utils -> src/utils/index.ts)
    const indexExtensions = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
    for (const ext of indexExtensions) {
      file = this.getFileByPath(searchPath + ext);
      if (file) return file;
    }
    
    // Try with ts/tsx extensions if no extension
    const extensions = ['.ts', '.tsx'];
    for (const ext of extensions) {
      if (!searchPath.includes('.') || searchPath.endsWith('/')) {
        file = this.getFileByPath(searchPath + ext);
        if (file) return file;
      }
    }

    // Try relative path resolution against all files
    const allFiles = this.getAllFiles();
    for (const f of allFiles) {
      if (f.relativePath === searchPath || f.relativePath === searchPath + '/index') {
        return f;
      }
    }

    return null;
  }

  /**
   * Trace all transitive imports for a file (dependency tree)
   */
  traceImports(fileId: number, maxDepth: number = 10): { file: FileInfo; depth: number; path: string[] }[] {
    const results: { file: FileInfo; depth: number; path: string[] }[] = [];
    const visited = new Set<number>();

    const trace = (currentFileId: number, depth: number, path: string[]) => {
      if (depth > maxDepth || visited.has(currentFileId)) return;
      visited.add(currentFileId);

      const imports = this.getImports(currentFileId);
      for (const imp of imports) {
        const resolved = this.resolveImportSource(imp.source);
        if (resolved && !visited.has(resolved.id)) {
          const newPath = [...path, imp.source];
          results.push({ file: resolved, depth: depth + 1, path: newPath });
          trace(resolved.id, depth + 1, newPath);
        }
      }
    };

    trace(fileId, 0, []);
    return results;
  }

  /**
   * Find circular dependencies in the project
   */
  findCircularDependencies(): string[][] {
    const allFiles = this.getAllFiles();
    const fileMap = new Map(allFiles.map((f) => [f.id, f]));
    const cycles: string[][] = [];
    const visited = new Set<number>();
    const recStack = new Map<number, number>(); // fileId -> index in current path

    const dfs = (fileId: number, path: number[]) => {
      if (recStack.has(fileId)) {
        // Found a cycle
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

      const imports = this.getImports(fileId);
      for (const imp of imports) {
        const resolved = this.resolveImportSource(imp.source);
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

    // Deduplicate cycles (same cycle starting at different points)
    const uniqueCycles: string[][] = [];
    for (const cycle of cycles) {
      const normalized = this.normalizeCycle(cycle);
      const isDuplicate = uniqueCycles.some((uc) => this.cyclesEqual(uc, normalized));
      if (!isDuplicate) {
        uniqueCycles.push(normalized);
      }
    }

    // Store circular dependencies in database
    runWithRetry(async () => {
      for (const cycle of uniqueCycles) {
        getStatement(
          `INSERT OR IGNORE INTO circular_dependencies (cycle_path, file_count) VALUES (?, ?)`
        ).run(cycle.join(' -> '), cycle.length);
      }
    }, {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 1000,
      retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'database is locked'],
    });

    return uniqueCycles;
  }

  private normalizeCycle(cycle: string[]): string[] {
    // Rotate to start with lexicographically smallest element
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

  /**
   * Get coherence decisions for a file
   */
  getCoherenceDecisions(fileId: number): { id: number; verdict: string; confidence: number; analyzedAt: string; llmProvider: string | null }[] {
    const rows = getStatement(`
      SELECT id, verdict, confidence, analyzed_at, llm_provider 
      FROM coherence_decisions 
      WHERE file_id = ? 
      ORDER BY analyzed_at DESC
    `).all(fileId) as Record<string, unknown>[];
    
    return rows.map((r) => ({
      id: r.id as number,
      verdict: r.verdict as string,
      confidence: r.confidence as number,
      analyzedAt: r.analyzed_at as string,
      llmProvider: (r.llm_provider as string | null) ?? null,
    }));
  }

  /**
   * Get dependency graph for a module (all files in a directory and their imports)
   */
  getDependencyGraph(modulePath: string): { nodes: FileInfo[]; edges: { from: string; to: string; kind: string }[] } {
    const allFiles = this.getAllFiles();
    const moduleFiles = allFiles.filter((f) => f.relativePath.startsWith(modulePath));
    const moduleFileIds = new Set(moduleFiles.map((f) => f.id));

    const nodes = moduleFiles;
    const edges: { from: string; to: string; kind: string }[] = [];

    for (const file of moduleFiles) {
      const imports = this.getImports(file.id);
      for (const imp of imports) {
        const resolved = this.resolveImportSource(imp.source);
        if (resolved && moduleFileIds.has(resolved.id)) {
          edges.push({ from: file.relativePath, to: resolved.relativePath, kind: imp.kind });
        }
      }
    }

    return { nodes, edges };
  }

  /**
   * Find all files matching an import pattern (for path resolution)
   */
  findFilesByImportPattern(pattern: string): FileInfo[] {
    const allFiles = this.getAllFiles();
    const normalizedPattern = pattern.replace(/\\/g, '/').toLowerCase();
    
    return allFiles.filter((f) => {
      const rel = f.relativePath.replace(/\\/g, '/').toLowerCase();
      const fileName = rel.split('/').pop() || '';
      const pathSegments = rel.split('/');
      
      // Exact match on full path
      if (rel === normalizedPattern) return true;
      
      // Match any path segment exactly
      if (pathSegments.some(seg => seg === normalizedPattern)) return true;
      
      // Match filename (with or without extension)
      if (fileName === normalizedPattern) return true;
      if (fileName.startsWith(normalizedPattern + '.')) return true;
      if (fileName.endsWith('.' + normalizedPattern)) return true;
      
      // Match as substring in path (for partial matches like "config" in "src/utils/config.ts")
      if (rel.includes(normalizedPattern)) return true;
      
      // Match prefix/suffix patterns
      if (rel.startsWith(normalizedPattern + '/')) return true;
      if (rel.endsWith('/' + normalizedPattern)) return true;
      if (rel.includes('/' + normalizedPattern + '/')) return true;
      
      return false;
    });
  }

  /**
   * Get file by import path (used by coding agents to resolve imports)
   */
  getFileByImport(importPath: string, fromFilePath?: string): FileInfo | null {
    // First try direct resolution
    let file = this.resolveImportSource(importPath);
    if (file) return file;

    // If fromFilePath is provided, try relative resolution
    if (fromFilePath) {
      const fromFile = this.getFileByPath(fromFilePath);
      if (fromFile) {
        const fromDir = fromFile.relativePath.substring(0, fromFile.relativePath.lastIndexOf('/'));
        const resolvedPath = resolve(fromDir, importPath).replace(/\\/g, '/');
        file = this.resolveImportSource(resolvedPath);
        if (file) return file;
      }
    }

    return null;
  }

  private mapFileInfo(row: Record<string, unknown>): FileInfo {
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
    };
  }
}

/** Local helper to avoid importing findSimilar from embeddings (tree-shakable). */
function findSimilarIn(
  embedding: number[],
  candidates: { id: number; embedding: number[] }[],
  threshold: number,
  topK: number
): { id: number; score: number }[] {
  return candidates
    .map((c) => ({ id: c.id, score: cosineSimilarity(embedding, c.embedding) }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}