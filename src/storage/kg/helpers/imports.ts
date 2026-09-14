import { runWithRetry } from '../../database.js';
import { dirname, posix } from 'node:path';
import { FileInfo } from '../types.js';
import type { KgContext } from './context.js';
import type { SQLOutputValue } from 'node:sqlite';
import type { DatabaseSync } from 'node:sqlite';
import {
  getFileById,
  getFileByPath,
  getAllFiles,
  getImports,
  resolveImportSource,
  getImportPathCandidates,
} from './files.js';

export function getDependents(ctx: KgContext, fileId: number): FileInfo[] {
  // Dependents are files whose imports RESOLVED to this file.
  // Match on resolved_path (populated at scan time by resolveImportSource),
  // falling back to raw source equality for unresolvable-but-exact matches.
  const rows = ctx.db
    .prepare(
      `
    SELECT DISTINCT f.* FROM files f
    JOIN imports i ON f.id = i.file_id
    WHERE f.project_id = ? AND (
      i.resolved_path = (SELECT relative_path FROM files WHERE id = ? AND project_id = f.project_id)
      OR i.source = (SELECT relative_path FROM files WHERE id = ? AND project_id = f.project_id)
    )
  `,
    )
    .all(ctx.currentProjectId, fileId, fileId) as Record<string, SQLOutputValue>[];
  return rows.map((r) => ({
    id: r.id as number,
    path: r.path as string,
    relativePath: r.relative_path as string,
    language: r.language as string,
    sizeBytes: r.size_bytes as number,
    hash: r.hash as string,
    agentTouched: r.agent_touched === 1,
    agentTouchedBy: (r.agent_touched_by as string | null) ?? null,
    agentTouchedAt: (r.agent_touched_at as string | null) ?? null,
    cognitiveLoad: (r.cognitive_load as number) ?? 0,
    lastScanned: r.last_scanned as string,
    lastSynced: (r.last_synced as string) ?? (r.last_scanned as string),
    patterns: JSON.parse((r.patterns as string) ?? '[]') as string[],
  }));
}

export function getDirectDependents(ctx: KgContext, sourcePath: string): FileInfo[] {
  const normalizedSource = sourcePath.replace(/\\/g, '/');
  const rows = ctx.db
    .prepare(
      `
    SELECT DISTINCT f.* FROM files f
    JOIN imports i ON f.id = i.file_id
    WHERE f.project_id = ? AND (i.resolved_path = ? OR i.source = ?)
  `,
    )
    .all(ctx.currentProjectId, normalizedSource, normalizedSource) as Record<
    string,
    SQLOutputValue
  >[];
  return rows.map((r) => ({
    id: r.id as number,
    path: r.path as string,
    relativePath: r.relative_path as string,
    language: r.language as string,
    sizeBytes: r.size_bytes as number,
    hash: r.hash as string,
    agentTouched: r.agent_touched === 1,
    agentTouchedBy: (r.agent_touched_by as string | null) ?? null,
    agentTouchedAt: (r.agent_touched_at as string | null) ?? null,
    cognitiveLoad: (r.cognitive_load as number) ?? 0,
    lastScanned: r.last_scanned as string,
    lastSynced: (r.last_synced as string) ?? (r.last_scanned as string),
    patterns: JSON.parse((r.patterns as string) ?? '[]') as string[],
  }));
}

export function getImportsWithDetails(
  ctx: KgContext,
  fileId: number,
): { source: string; kind: string; resolvedFile: FileInfo | null }[] {
  const imports = getImports(ctx, fileId);
  const importingFile = getFileById(ctx, fileId);
  const fromDir = importingFile
    ? dirname(importingFile.relativePath).replace(/\\/g, '/')
    : undefined;
  return imports.map((imp) => ({
    ...imp,
    resolvedFile: resolveImportSource(ctx, imp.source, fromDir),
  }));
}

export interface ImportAnalysisStats {
  totalImports: number;
  resolvedImports: number;
  unresolvedImports: number;
  externalDependencies: number;
}

/**
 * Return project-wide import counters without resolving every import again.
 *
 * The scan tool only needs aggregate counters, so resolving against one
 * in-memory file index preserves the live resolver's candidate order and
 * avoids the previous N-files × N-imports resolution/query loop. We do not
 * trust `imports.resolved_path` alone here: older cache rows can point at a
 * similarly named file while the import is not resolvable from its owner.
 * Built-in and external modules intentionally remain unresolved file edges
 * because they do not point to an indexed project file.
 */
export function getImportStats(ctx: KgContext): ImportAnalysisStats {
  const files = ctx.db
    .prepare('SELECT relative_path, path FROM files WHERE project_id = ?')
    .all(ctx.currentProjectId) as Array<{ relative_path: string; path: string }>;
  const relativePaths = new Set(files.map((file) => file.relative_path.replace(/\\/g, '/')));
  const absolutePaths = new Map(
    files.map((file) => [file.path.replace(/\\/g, '/'), file.relative_path.replace(/\\/g, '/')]),
  );
  const rows = ctx.db
    .prepare(
      `
      SELECT i.source, owner.relative_path AS owner_relative_path
      FROM imports i
      JOIN files owner ON owner.id = i.file_id AND owner.project_id = ?
      `,
    )
    .all(ctx.currentProjectId) as Array<{ source: string; owner_relative_path: string }>;

  let resolvedImports = 0;
  let externalDependencies = 0;
  for (const row of rows) {
    if (
      !row.source.startsWith('node:') &&
      resolveImportPathFromIndex(
        row.source,
        row.owner_relative_path,
        relativePaths,
        absolutePaths,
      ) !== null
    ) {
      resolvedImports++;
    } else if (isExternalImport(row.source)) {
      externalDependencies++;
    }
  }

  return {
    totalImports: rows.length,
    resolvedImports,
    unresolvedImports: rows.length - resolvedImports,
    externalDependencies,
  };
}

/**
 * Re-resolve persisted project-local import edges after a scan.
 *
 * A scanner may encounter an importer before its newly added target file. The
 * first write then correctly records an unresolved edge, but leaving that row
 * stale would make impact/dead-code consumers disagree with the live resolver.
 * Resolve against one project-wide file index after the batch so scan order
 * cannot change graph semantics. Built-ins retain their historical resolved
 * marker while external modules remain non-project edges.
 */
export function refreshImportResolution(ctx: KgContext): number {
  const fileRows = ctx.db
    .prepare('SELECT relative_path, path FROM files WHERE project_id = ?')
    .all(ctx.currentProjectId) as Array<{ relative_path: string; path: string }>;
  const relativePaths = new Set(fileRows.map((file) => file.relative_path.replace(/\\/g, '/')));
  const absolutePaths = new Map(
    fileRows.map((file) => [file.path.replace(/\\/g, '/'), file.relative_path.replace(/\\/g, '/')]),
  );
  const rows = ctx.db
    .prepare(
      `
      SELECT i.id, i.source, i.resolved, i.resolved_path,
             owner.relative_path AS owner_relative_path
      FROM imports i
      JOIN files owner ON owner.id = i.file_id AND owner.project_id = ?
      WHERE owner.project_id = ?
      `,
    )
    .all(ctx.currentProjectId, ctx.currentProjectId) as Array<{
    id: number;
    source: string;
    resolved: number;
    resolved_path: string | null;
    owner_relative_path: string;
  }>;

  const update = ctx.db.prepare('UPDATE imports SET resolved = ?, resolved_path = ? WHERE id = ?');
  let updated = 0;
  for (const row of rows) {
    const resolvedPath = resolveImportPathFromIndex(
      row.source,
      row.owner_relative_path,
      relativePaths,
      absolutePaths,
    );
    const resolved = resolvedPath === null ? 0 : 1;
    if (resolved !== row.resolved || resolvedPath !== row.resolved_path) {
      update.run(resolved, resolvedPath, row.id);
      updated++;
    }
  }
  return updated;
}

function resolveImportPathFromIndex(
  source: string,
  ownerRelativePath: string,
  relativePaths: ReadonlySet<string>,
  absolutePaths: ReadonlyMap<string, string>,
): string | null {
  const originalPath = source.replace(/\\/g, '/');
  const absoluteMatch = absolutePaths.get(originalPath);
  if (absoluteMatch) return absoluteMatch;

  if (source.startsWith('node:')) return source.slice('node:'.length);

  const fromDir = dirname(ownerRelativePath).replace(/\\/g, '/');
  let searchPath = originalPath;
  if (fromDir && (source.startsWith('./') || source.startsWith('../'))) {
    searchPath = posix.normalize(posix.join(fromDir, searchPath));
  }

  const searchPaths = getImportPathCandidates(searchPath);
  for (const candidate of searchPaths) {
    if (relativePaths.has(candidate)) return candidate;
  }

  const indexExtensions = [
    '/index.ts',
    '/index.tsx',
    '/index.mts',
    '/index.cts',
    '/index.js',
    '/index.jsx',
    '/index.mjs',
    '/index.cjs',
  ];
  for (const candidate of searchPaths) {
    const indexPath = indexExtensions.find((extension) => relativePaths.has(candidate + extension));
    if (indexPath) return candidate + indexPath;
  }

  const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
  for (const candidate of searchPaths) {
    // A period can belong to a directory name (`feature.v2/utils`) or to a
    // valid source basename (`client.test`). Exact candidates were checked
    // first, so probing every extension here is both safe and required for
    // extensionless imports below dotted directories.
    const extension = extensions.find((extension) => relativePaths.has(candidate + extension));
    if (extension) return candidate + extension;
  }
  return null;
}

function isExternalImport(source: string): boolean {
  return !source.startsWith('.') && !source.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(source);
}

export function traceImports(
  ctx: KgContext,
  fileId: number,
  maxDepth: number = 10,
): { file: FileInfo; depth: number; path: string[] }[] {
  const results: { file: FileInfo; depth: number; path: string[] }[] = [];
  const visited = new Set<number>();

  const trace = (currentFileId: number, depth: number, path: string[]) => {
    if (depth > maxDepth || visited.has(currentFileId)) return;
    visited.add(currentFileId);

    const fileImports = getImports(ctx, currentFileId);
    const importingFile = getFileById(ctx, currentFileId);
    const fromDir = importingFile
      ? dirname(importingFile.relativePath).replace(/\\/g, '/')
      : undefined;
    for (const imp of fileImports) {
      const resolved = resolveImportSource(ctx, imp.source, fromDir);
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

function normalizeCycle(cycle: string[]): string[] {
  let minIndex = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIndex]) minIndex = i;
  }
  return [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];
}

function cyclesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Full-project cycle detection is expensive (DFS over every file).
// Hot callers like get_context invoke it repeatedly, so results are
// memoized briefly; scans naturally outlive this TTL.
let _cycleCache: {
  db: DatabaseSync;
  projectId: number;
  cycles: string[][];
  computedAt: number;
} | null = null;
const CYCLE_CACHE_TTL_MS = 60_000;

export function findCircularDependencies(ctx: KgContext): string[][] {
  if (
    _cycleCache &&
    _cycleCache.db === ctx.db &&
    _cycleCache.projectId === ctx.currentProjectId &&
    Date.now() - _cycleCache.computedAt < CYCLE_CACHE_TTL_MS
  ) {
    return _cycleCache.cycles;
  }
  const allFiles = getAllFiles(ctx);
  const fileMap = new Map(allFiles.map((f) => [f.id, f]));
  const cycles: string[][] = [];
  const visited = new Set<number>();
  const recStack = new Map<number, number>();

  const dfs = (fileId: number, path: number[]) => {
    if (recStack.has(fileId)) {
      const cycleStart = recStack.get(fileId)!;
      const cycle = path
        .slice(cycleStart)
        .map((id) => fileMap.get(id)?.relativePath || '')
        .filter(Boolean);
      if (cycle.length > 0) {
        cycles.push(cycle);
      }
      return;
    }

    if (visited.has(fileId)) return;

    visited.add(fileId);
    recStack.set(fileId, path.length);
    path.push(fileId);

    const fileImports = getImports(ctx, fileId);
    const importingFile = fileMap.get(fileId);
    const fromDir = importingFile
      ? dirname(importingFile.relativePath).replace(/\\/g, '/')
      : undefined;
    for (const imp of fileImports) {
      const resolved = resolveImportSource(ctx, imp.source, fromDir);
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

  const uniqueCycles: string[][] = [];
  for (const cycle of cycles) {
    const normalized = normalizeCycle(cycle);
    const isDuplicate = uniqueCycles.some((uc) => cyclesEqual(uc, normalized));
    if (!isDuplicate) {
      uniqueCycles.push(normalized);
    }
  }

  runWithRetry(
    async () => {
      for (const cycle of uniqueCycles) {
        ctx.db
          .prepare(
            `INSERT OR IGNORE INTO circular_dependencies (cycle_path, file_count) VALUES (?, ?)`,
          )
          .run(cycle.join(' -> '), cycle.length);
      }
    },
    {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 1000,
      retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'database is locked'],
    },
  );

  _cycleCache = {
    db: ctx.db,
    projectId: ctx.currentProjectId,
    cycles: uniqueCycles,
    computedAt: Date.now(),
  };
  return uniqueCycles;
}

/** Invalidate cached cycles after a file's import relations change. */
export function invalidateCircularDependencyCache(): void {
  _cycleCache = null;
}

export function ingestDynamicCalls(
  ctx: KgContext,
  calls: {
    fromFunctionName: string;
    toFunctionName: string;
    workloadId: string;
    callCount?: number;
    staticMissed?: boolean;
  }[],
): { inserted: number; updated: number; errors: string[] } {
  let inserted = 0;
  let updated = 0;
  const errors: string[] = [];

  const ensureFunction = (name: string): number | null => {
    const existing = ctx.db.prepare('SELECT id FROM functions WHERE name = ? LIMIT 1').get(name) as
      { id: number } | undefined;
    if (existing) return existing.id;
    return null;
  };

  for (const call of calls) {
    try {
      const fromFnId = ensureFunction(call.fromFunctionName);
      const toFnId = ensureFunction(call.toFunctionName);
      if (!fromFnId || !toFnId) {
        errors.push(`Function not found: ${call.fromFunctionName} -> ${call.toFunctionName}`);
        continue;
      }
      const existing = ctx.db
        .prepare(
          `SELECT id, call_count FROM calls WHERE from_function_id = ? AND to_function_id = ? AND workload_id = ?`,
        )
        .get(fromFnId, toFnId, call.workloadId) as { id: number; call_count: number } | undefined;
      if (existing) {
        ctx.db
          .prepare(
            `UPDATE calls SET call_count = call_count + ?, dynamic = 1, static_missed = ? WHERE id = ?`,
          )
          .run(call.callCount ?? 1, call.staticMissed ? 1 : 0, existing.id);
        updated++;
      } else {
        ctx.db
          .prepare(
            `INSERT INTO calls (from_function_id, to_function_id, dynamic, static_missed, call_count, workload_id)
           VALUES (?, ?, 1, ?, ?, ?)`,
          )
          .run(fromFnId, toFnId, call.staticMissed ? 1 : 0, call.callCount ?? 1, call.workloadId);
        inserted++;
      }
    } catch (e) {
      errors.push(`Error processing ${call.fromFunctionName} -> ${call.toFunctionName}: ${e}`);
    }
  }

  return { inserted, updated, errors };
}

export function getDynamicCalls(
  ctx: KgContext,
  workloadId: string,
): {
  fromFunctionId: number;
  toFunctionId: number;
  callCount: number;
  staticMissed: boolean;
  workloadId: string;
  fromFunctionName: string;
  toFunctionName: string;
}[] {
  const rows = ctx.db
    .prepare(
      `SELECT c.*, f1.name as from_name, f2.name as to_name
     FROM calls c
     JOIN functions f1 ON c.from_function_id = f1.id
     JOIN functions f2 ON c.to_function_id = f2.id
     WHERE c.workload_id = ? AND c.dynamic = 1`,
    )
    .all(workloadId) as Record<string, SQLOutputValue>[];

  return rows.map((r) => ({
    fromFunctionId: r.from_function_id as number,
    toFunctionId: r.to_function_id as number,
    callCount: r.call_count as number,
    staticMissed: (r.static_missed as number) === 1,
    workloadId: r.workload_id as string,
    fromFunctionName: (r.from_name as string) || '',
    toFunctionName: (r.to_name as string) || '',
  }));
}

export function getAllDynamicCalls(ctx: KgContext): {
  fromFunctionId: number;
  toFunctionId: number;
  callCount: number;
  staticMissed: boolean;
  workloadId: string;
  fromFunctionName: string;
  toFunctionName: string;
}[] {
  const rows = ctx.db
    .prepare(
      `SELECT c.*, f1.name as from_name, f2.name as to_name
     FROM calls c
     JOIN functions f1 ON c.from_function_id = f1.id
     JOIN functions f2 ON c.to_function_id = f2.id
     WHERE c.dynamic = 1`,
    )
    .all() as Record<string, SQLOutputValue>[];

  return rows.map((r) => ({
    fromFunctionId: r.from_function_id as number,
    toFunctionId: r.to_function_id as number,
    callCount: r.call_count as number,
    staticMissed: (r.static_missed as number) === 1,
    workloadId: r.workload_id as string,
    fromFunctionName: (r.from_name as string) || '',
    toFunctionName: (r.to_name as string) || '',
  }));
}

export function getStaticMissedCalls(ctx: KgContext): {
  fromFunctionName: string;
  toFunctionName: string;
  workloadId: string;
  callCount: number;
  staticMissed: boolean;
}[] {
  const rows = ctx.db
    .prepare(
      `SELECT c.*, f1.name as from_name, f2.name as to_name
     FROM calls c
     JOIN functions f1 ON c.from_function_id = f1.id
     JOIN functions f2 ON c.to_function_id = f2.id
     WHERE c.dynamic = 1 AND c.static_missed = 1`,
    )
    .all() as Record<string, SQLOutputValue>[];

  return rows.map((r) => ({
    fromFunctionName: (r.from_name as string) || '',
    toFunctionName: (r.to_name as string) || '',
    workloadId: r.workload_id as string,
    callCount: r.call_count as number,
    staticMissed: true,
  }));
}

export function clearDynamicCalls(ctx: KgContext, workloadId: string): number {
  const result = ctx.db.prepare(`DELETE FROM calls WHERE workload_id = ?`).run(workloadId);
  return Number(result.changes);
}

export function clearAllDynamicCalls(ctx: KgContext): number {
  const result = ctx.db.prepare(`DELETE FROM calls WHERE dynamic = 1`).run();
  return Number(result.changes);
}

export function getCoherenceDecisions(
  ctx: KgContext,
  fileId: number,
): {
  id: number;
  verdict: string;
  confidence: number;
  analyzedAt: string;
  llmProvider: string | null;
}[] {
  const rows = ctx.db
    .prepare(
      `
    SELECT id, verdict, confidence, analyzed_at, llm_provider 
    FROM coherence_decisions 
    WHERE file_id = ? 
    ORDER BY analyzed_at DESC
  `,
    )
    .all(fileId) as Record<string, SQLOutputValue>[];

  return rows.map((r) => ({
    id: r.id as number,
    verdict: r.verdict as string,
    confidence: r.confidence as number,
    analyzedAt: r.analyzed_at as string,
    llmProvider: (r.llm_provider as string | null) ?? null,
  }));
}

export function getDependencyGraph(
  ctx: KgContext,
  modulePath: string,
): { nodes: FileInfo[]; edges: { from: string; to: string; kind: string }[] } {
  const allFiles = getAllFiles(ctx);
  const moduleFiles = allFiles.filter((f) => f.relativePath.startsWith(modulePath));
  const moduleFileIds = new Set(moduleFiles.map((f) => f.id));

  const nodes = moduleFiles;
  const edges: { from: string; to: string; kind: string }[] = [];

  for (const file of moduleFiles) {
    const fileImports = getImports(ctx, file.id);
    const fromDir = dirname(file.relativePath).replace(/\\/g, '/');
    for (const imp of fileImports) {
      const resolved = resolveImportSource(ctx, imp.source, fromDir);
      if (resolved && moduleFileIds.has(resolved.id)) {
        edges.push({ from: file.relativePath, to: resolved.relativePath, kind: imp.kind });
      }
    }
  }

  return { nodes, edges };
}

export function findFilesByImportPattern(ctx: KgContext, pattern: string): FileInfo[] {
  const allFiles = getAllFiles(ctx);
  const normalizedPattern = pattern.replace(/\\/g, '/').toLowerCase();

  return allFiles.filter((f) => {
    const rel = f.relativePath.replace(/\\/g, '/').toLowerCase();
    const fileName = rel.split('/').pop() || '';
    const pathSegments = rel.split('/');

    if (rel === normalizedPattern) return true;
    if (pathSegments.some((seg) => seg === normalizedPattern)) return true;
    if (fileName === normalizedPattern) return true;
    if (fileName.startsWith(normalizedPattern + '.')) return true;
    if (fileName.endsWith('.' + normalizedPattern)) return true;
    if (rel.includes(normalizedPattern)) return true;
    if (rel.startsWith(normalizedPattern + '/')) return true;
    if (rel.endsWith('/' + normalizedPattern)) return true;
    if (rel.includes('/' + normalizedPattern + '/')) return true;

    return false;
  });
}

export function getFileByImport(
  ctx: KgContext,
  importPath: string,
  fromFilePath?: string,
): FileInfo | null {
  let file = resolveImportSource(ctx, importPath);
  if (file) return file;

  if (fromFilePath) {
    const fromFile = getFileByPath(ctx, fromFilePath);
    if (fromFile) {
      const fromDir = dirname(fromFile.relativePath).replace(/\\/g, '/');
      file = resolveImportSource(ctx, importPath, fromDir);
      if (file) return file;
    }
  }

  return null;
}
