
import { existsSync, readFileSync } from 'node:fs';

import { dirname, join, resolve } from 'node:path';

import type { SQLOutputValue } from 'node:sqlite';

import { globalCacheRegistry } from '../../../core/cache/index.js';

import { getDefaultImportResolutionCache } from '../../../core/cache/import-resolution-cache.js';

import { getVecIndex } from '../../../core/embeddings/vector-index.js';

import { FileStructure } from '../../../parser/ast-parser.js';

import { AliasResolver, getDefaultAliasResolver } from '../../../parser/alias-resolver.js';

import { codeToEmbedding, cosineSimilarity } from '../../../parser/embeddings.js';

import { loadConfig } from '../../../utils/config.js';
import { getStatement, runWithRetry } from '../../database.js';

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

function clearFileRelations(ctx: KgContext, fileId: number): void {
  getStatement('DELETE FROM functions WHERE file_id = ?').run(fileId);
  getStatement('DELETE FROM classes WHERE file_id = ?').run(fileId);
  getStatement('DELETE FROM imports WHERE file_id = ?').run(fileId);
}

function calculateCognitiveLoad(fileStruct: FileStructure): number {
  const complexityScore = fileStruct.functions.reduce(
    (sum: number, fn: { cyclomaticComplexity: number }) => sum + fn.cyclomaticComplexity, 0
  );
  const importCount = fileStruct.imports.length;
  const functionCount = fileStruct.functions.length;
  return (complexityScore * 0.5 + importCount * 0.3 + functionCount * 0.2) / 100;
}

export function getFileByPath(ctx: KgContext, path: string, projectId?: number): FileInfo | null {
  const normalized = path.replace(/\\/g, '/');
  const pid = projectId ?? ctx.currentProjectId;
  // Exact matches first (raw, then normalized), case-insensitive last.
  const lookups: Array<[string, string]> = [
    ['SELECT * FROM files WHERE path = ? AND project_id = ?', path],
    ['SELECT * FROM files WHERE path = ? AND project_id = ?', normalized],
    ['SELECT * FROM files WHERE relative_path = ? AND project_id = ?', normalized],
    ['SELECT * FROM files WHERE relative_path = ? COLLATE NOCASE AND project_id = ?', normalized],
    ['SELECT * FROM files WHERE path = ? COLLATE NOCASE AND project_id = ?', normalized],
  ];
  for (const [sql, value] of lookups) {
    const row = getStatement(sql).get(value, pid) as Record<string, SQLOutputValue> | undefined;
    if (row) return mapFileInfo(row);
  }
  return null;
}

let _allFilesCache: { projectId: number; files: FileInfo[]; computedAt: number } | null = null;
const ALL_FILES_CACHE_TTL_MS = 5_000;

export function resolveImportSource(ctx: KgContext, source: string, fromDir?: string): FileInfo | null {
  let searchPath = source;
  if (fromDir && (source.startsWith('./') || source.startsWith('../'))) {
    searchPath = resolve(fromDir, source).replace(/\\/g, '/');
    const config = loadConfig();
    const projectRoot = config.projectRoot.replace(/\\/g, '/');
    if (searchPath.startsWith(projectRoot)) {
      searchPath = searchPath.slice(projectRoot.length + 1);
    }
  }

  const jsExtensions = ['.js', '.jsx', '.mjs', '.cjs'];
  const tsExtensions = ['.ts', '.tsx', '.ts', '.ts'];
  for (let i = 0; i < jsExtensions.length; i++) {
    if (searchPath.endsWith(jsExtensions[i])) {
      searchPath = searchPath.slice(0, -jsExtensions[i].length) + tsExtensions[i];
      break;
    }
  }

  let file = getFileByPath(ctx, searchPath);
  if (file) return file;

  const indexExtensions = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
  for (const ext of indexExtensions) {
    file = getFileByPath(ctx, searchPath + ext);
    if (file) return file;
  }

  const extensions = ['.ts', '.tsx'];
  for (const ext of extensions) {
    if (!searchPath.includes('.') || searchPath.endsWith('/')) {
      file = getFileByPath(ctx, searchPath + ext);
      if (file) return file;
    }
  }

  if (
    !_allFilesCache ||
    _allFilesCache.projectId !== ctx.currentProjectId ||
    Date.now() - _allFilesCache.computedAt >= ALL_FILES_CACHE_TTL_MS
  ) {
    _allFilesCache = { projectId: ctx.currentProjectId, files: getAllFiles(ctx), computedAt: Date.now() };
  }
  for (const f of _allFilesCache.files) {
    if (f.relativePath === searchPath || f.relativePath === searchPath + '/index') {
      return f;
    }
  }

  return null;
}

/**
 * Decode an embedding stored in either legacy JSON TEXT or new Float32 BLOB
 * format. Empty array signals unreadable/corrupt value.
 */
function decodeEmbedding(raw: SQLOutputValue | null): number[] {
  if (raw instanceof Uint8Array) {
    const floats = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
    return Array.from(floats);
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw as string) as number[];
      return Array.isArray(parsed) ? parsed.map(Number) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export async function upsertFile(ctx: KgContext, fileStruct: FileStructure, relativePath: string): Promise<number> {
  const embedding = codeToEmbedding(fileStruct.functions.map((f) => f.signature).join('\n'));
  // Compact Float32 BLOB (~4 bytes/dim) instead of JSON text (~7+/bytes/dim).
  // Readers accept BOTH formats, so pre-existing TEXT rows convert gradually
  // on rescan without a destructive migration.
  const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
  const cognitiveLoad = calculateCognitiveLoad(fileStruct);

  return runWithRetry(async () => {
    const existing = getStatement('SELECT id FROM files WHERE path = ? AND project_id = ?').get(fileStruct.filePath, ctx.currentProjectId) as { id: number } | undefined;

    if (existing) {
      getStatement(`UPDATE files SET relative_path = ?, language = ?, size_bytes = ?, hash = ?, embedding = ?, 
         last_scanned = CURRENT_TIMESTAMP, cognitive_load = ? WHERE id = ?`).run(
        relativePath,
        fileStruct.language,
        fileStruct.sizeBytes,
        fileStruct.hash,
        embeddingBlob,
        cognitiveLoad,
        existing.id
      );
      // The embedding changed — evict the stale cached copy so similarity
      // search reflects the new content instead of the pre-update vector.
      globalCacheRegistry.get('embeddings')?.delete(`file:${existing.id}`);
      clearFileRelations(ctx, existing.id);
      // Keep the sqlite-vec index in sync.
      getVecIndex(ctx.db).upsert(existing.id, embedding);
      return existing.id;
    } else {
      const result = getStatement(`INSERT INTO files (project_id, path, relative_path, language, size_bytes, hash, embedding, cognitive_load)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ctx.currentProjectId,
        fileStruct.filePath,
        relativePath,
        fileStruct.language,
        fileStruct.sizeBytes,
        fileStruct.hash,
        embeddingBlob,
        cognitiveLoad
      );
      const newId = Number(result.lastInsertRowid);
      // Keep the sqlite-vec index in sync.
      getVecIndex(ctx.db).upsert(newId, embedding);
      return newId;
    }
  });
}

export async function storeFileDetails(ctx: KgContext, fileId: number, fileStruct: FileStructure): Promise<void> {
  return runWithRetry(async () => {
    ctx.db.exec('SAVEPOINT storeFileDetails');
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
      const fromFile = getFileByPath(ctx, fileStruct.filePath);
      const fromDir = fromFile ? dirname(fromFile.relativePath).replace(/\\/g, '/') : '';

      const config = loadConfig();
      const projectRoot = config.projectRoot;

      // Use the AliasResolver for tsconfig path alias resolution
      const aliasResolver = getDefaultAliasResolver();
      aliasResolver.loadAliases();

      // Use the import resolution cache for faster lookups
      const importCache = getDefaultImportResolutionCache();

      for (const imp of fileStruct.imports) {
        let resolved = false;
        let resolvedPath: string | null = null;

        // Auto-resolve Node.js built-in modules (e.g. 'node:fs', 'node:path').
        if (imp.source.startsWith('node:')) {
          resolved = true;
          resolvedPath = imp.source.slice('node:'.length);
        }

        // Try alias resolution first for bare imports
        if (!resolved && aliasResolver.isResolvable(imp.source)) {
          const aliasPath = aliasResolver.resolveAliasToPath(imp.source);
          if (aliasPath) {
            const found = resolveImportSource(ctx, aliasPath);
            if (found) {
              resolved = true;
              resolvedPath = found.relativePath;
            }
          }
        }

        // Use import resolution cache for relative imports and fallback
        if (!resolved) {
          const cacheResult = importCache.resolve(imp.source, fromDir, ctx.db, ctx.currentProjectId);
          if (cacheResult.resolved && cacheResult.resolvedPath) {
            resolved = true;
            resolvedPath = cacheResult.resolvedPath;
          }
        }

        // Final fallback to direct resolution
        if (!resolved) {
          const found = resolveImportSource(ctx, imp.source, fromDir);
          if (found) {
            resolved = true;
            resolvedPath = found.relativePath;
          }
        }

        impStmt.run(fileId, imp.source, imp.kind, resolved ? 1 : 0, resolvedPath);
      }

      ctx.db.exec('RELEASE SAVEPOINT storeFileDetails');
    } catch (e) {
      ctx.db.exec('ROLLBACK TO SAVEPOINT storeFileDetails');
      throw e;
    }
  }, {
    maxAttempts: 3,
    baseDelayMs: 50,
    maxDelayMs: 1000,
    retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'database is locked'],
  });
}

export function markAgentTouched(ctx: KgContext, filePath: string, agentName: string): Promise<void> {
  return runWithRetry(async () => {
    const normalized = filePath.replace(/\\/g, '/');
    getStatement(
      `UPDATE files SET agent_touched = 1, agent_touched_by = ?, agent_touched_at = CURRENT_TIMESTAMP 
       WHERE path = ? OR relative_path = ?`
    ).run(agentName, normalized, normalized);
  });
}

export function getFilesByLanguage(ctx: KgContext, language: string, projectId?: number): FileInfo[] {
  const pid = projectId ?? ctx.currentProjectId;
  const rows = getStatement('SELECT * FROM files WHERE language = ? AND project_id = ? ORDER BY last_scanned DESC')
    .all(language, pid) as Record<string, SQLOutputValue>[];
  return rows.map((r) => mapFileInfo(r));
}

export function getAllFiles(ctx: KgContext, projectId?: number): FileInfo[] {
  const pid = projectId ?? ctx.currentProjectId;
  const rows = getStatement('SELECT * FROM files WHERE project_id = ? ORDER BY path').all(pid) as Record<string, SQLOutputValue>[];
  return rows.map((r) => mapFileInfo(r));
}

export function getAgentTouchedFiles(ctx: KgContext, agentName?: string, projectId?: number): FileInfo[] {
  const pid = projectId ?? ctx.currentProjectId;
  const sql = agentName
    ? 'SELECT * FROM files WHERE agent_touched = 1 AND agent_touched_by = ? AND project_id = ? ORDER BY agent_touched_at DESC'
    : 'SELECT * FROM files WHERE agent_touched = 1 AND project_id = ? ORDER BY agent_touched_at DESC';
  const rows = (agentName
    ? getStatement(sql).all(agentName, pid)
    : getStatement(sql).all(pid)
  ) as Record<string, SQLOutputValue>[];
  return rows.map((r) => mapFileInfo(r));
}

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

export function findSimilarFiles(ctx: KgContext, targetEmbedding: number[], threshold = 0.7, limit = 10): FileInfo[] {
  if (targetEmbedding.length === 0) {
    const allFiles = getAllFiles(ctx);
    return allFiles.slice(0, limit);
  }

  // ------------------------------------------------------------------
  // Fast path: sqlite-vec ANN search (sub-millisecond on 10K+ vectors).
  // The virtual table contains embeddings for ALL projects (IDs are
  // globally unique).  We over-fetch, then filter by threshold so the
  // caller gets only high-quality matches.
  // ------------------------------------------------------------------
  const vecIndex = getVecIndex(ctx.db);
  if (vecIndex.isAvailable()) {
    const overfetch = Math.max(limit * 3, 30);
    // K9: project-scoped search — the vec table spans ALL projects, so an
    // unfiltered MATCH can surface files from other projects.
    const rawMatches = vecIndex.findSimilar(targetEmbedding, overfetch, ctx.currentProjectId);

    // Convert cosine distance → similarity score and apply threshold.
    const goodIds: number[] = [];
    for (const m of rawMatches) {
      const score = 1 - m.distance;
      if (score >= threshold) goodIds.push(m.id);
    }

    if (goodIds.length > 0) {
      const ids = goodIds.slice(0, limit);
      const placeholders = ids.map(() => '?').join(',');
      const resultRows = getStatement(`SELECT * FROM files WHERE id IN (${placeholders})`)
        .all(...ids) as Record<string, SQLOutputValue>[];
      return resultRows.map((r) => mapFileInfo(r));
    }
    // No vec matches above threshold → fall through to brute-force
    // (handles edge cases like dimension mismatch or stale index).
  }

  // ------------------------------------------------------------------
  // Fallback: full-table scan with in-memory cosine similarity.
  // Used when sqlite-vec is unavailable or the vec index returned no
  // results above threshold.
  // ------------------------------------------------------------------
  const allFiles = getAllFiles(ctx);

  const ids = allFiles.map((f) => f.id);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const rows = getStatement(`SELECT id, embedding FROM files WHERE id IN (${placeholders})`)
    .all(...ids) as { id: number; embedding: SQLOutputValue | null }[];

  const embeddingMap = new Map<number, number[]>();
  for (const row of rows) {
    if (!row.embedding) continue;
    const decoded = decodeEmbedding(row.embedding);
    if (decoded.length > 0) embeddingMap.set(row.id, decoded);
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
    .all(...matchIds) as Record<string, SQLOutputValue>[];
  return resultRows.map((r) => mapFileInfo(r));
}

export function getFunctions(ctx: KgContext, fileId: number): { id: number; name: string; signature: string; complexity: number; startLine: number; endLine: number }[] {
  const rows = getStatement('SELECT id, name, signature, complexity, start_line, end_line FROM functions WHERE file_id = ?').all(fileId) as Record<string, SQLOutputValue>[];
  return rows.map(r => ({
    id: r.id as number,
    name: r.name as string,
    signature: r.signature as string,
    complexity: r.complexity as number,
    startLine: r.start_line as number,
    endLine: r.end_line as number,
  }));
}

export function getClasses(ctx: KgContext, fileId: number): { id: number; name: string; methodsCount: number; propertiesCount: number }[] {
  const rows = getStatement('SELECT id, name, methods_count, properties_count FROM classes WHERE file_id = ?').all(fileId) as Record<string, SQLOutputValue>[];
  return rows.map(r => ({
    id: r.id as number,
    name: r.name as string,
    methodsCount: r.methods_count as number,
    propertiesCount: r.properties_count as number,
  }));
}

export function getImports(ctx: KgContext, fileId: number): { source: string; named: string[]; kind: string }[] {
  const rows = getStatement('SELECT * FROM imports WHERE file_id = ?').all(fileId) as Record<string, SQLOutputValue>[];
  return rows.map((r) => ({
    source: r.source as string,
    named: [],
    kind: r.kind as string,
  }));
}

export function getFileEmbedding(ctx: KgContext, fileId: number): number[] | null {
  const row = getStatement('SELECT embedding FROM files WHERE id = ?').get(fileId) as { embedding: SQLOutputValue | null } | undefined;
  if (!row || !row.embedding) return null;
  const decoded = decodeEmbedding(row.embedding);
  return decoded.length > 0 ? decoded : null;
}
