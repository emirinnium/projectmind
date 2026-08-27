import { getStatement, runWithRetry } from '../../database.js';
import { resolve } from 'node:path';
import { FileInfo } from '../types.js';
import type { KgContext } from './context.js';
import type { SQLOutputValue } from 'node:sqlite';
import { getFileByPath, getAllFiles, getImports, resolveImportSource } from './files.js';

export function getDependents(ctx: KgContext, fileId: number): FileInfo[] {
  // Dependents are files whose imports RESOLVED to this file.
  // Match on resolved_path (populated at scan time by resolveImportSource),
  // falling back to raw source equality for unresolvable-but-exact matches.
  const rows = getStatement(`
    SELECT DISTINCT f.* FROM files f
    JOIN imports i ON f.id = i.file_id
    WHERE f.project_id = ? AND (
      i.resolved_path = (SELECT relative_path FROM files WHERE id = ? AND project_id = f.project_id)
      OR i.source = (SELECT relative_path FROM files WHERE id = ? AND project_id = f.project_id)
    )
  `).all(ctx.currentProjectId, fileId, fileId) as Record<string, SQLOutputValue>[];
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
  const rows = getStatement(`
    SELECT DISTINCT f.* FROM files f
    JOIN imports i ON f.id = i.file_id
    WHERE f.project_id = ? AND (i.resolved_path = ? OR i.source = ?)
  `).all(ctx.currentProjectId, normalizedSource, normalizedSource) as Record<string, SQLOutputValue>[];
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

export function getImportsWithDetails(ctx: KgContext, fileId: number): { source: string; kind: string; resolvedFile: FileInfo | null }[] {
  const imports = getImports(ctx, fileId);
  return imports.map((imp) => ({
    ...imp,
    resolvedFile: resolveImportSource(ctx, imp.source),
  }));
}

export function traceImports(ctx: KgContext, fileId: number, maxDepth: number = 10): { file: FileInfo; depth: number; path: string[] }[] {
  const results: { file: FileInfo; depth: number; path: string[] }[] = [];
  const visited = new Set<number>();

  const trace = (currentFileId: number, depth: number, path: string[]) => {
    if (depth > maxDepth || visited.has(currentFileId)) return;
    visited.add(currentFileId);

    const fileImports = getImports(ctx, currentFileId);
    for (const imp of fileImports) {
      const resolved = resolveImportSource(ctx, imp.source);
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
let _cycleCache: { cycles: string[][]; computedAt: number } | null = null;
const CYCLE_CACHE_TTL_MS = 60_000;

export function findCircularDependencies(ctx: KgContext): string[][] {
  if (_cycleCache && Date.now() - _cycleCache.computedAt < CYCLE_CACHE_TTL_MS) {
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

    const fileImports = getImports(ctx, fileId);
    for (const imp of fileImports) {
      const resolved = resolveImportSource(ctx, imp.source);
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

  _cycleCache = { cycles: uniqueCycles, computedAt: Date.now() };
  return uniqueCycles;
}

export function ingestDynamicCalls(ctx: KgContext, calls: { fromFunctionName: string; toFunctionName: string; workloadId: string; callCount?: number; staticMissed?: boolean }[]): { inserted: number; updated: number; errors: string[] } {
  let inserted = 0;
  let updated = 0;
  const errors: string[] = [];

  const ensureFunction = (name: string): number => {
    const existing = getStatement('SELECT id FROM functions WHERE name = ? LIMIT 1').get(name) as { id: number } | undefined;
    if (existing) return existing.id;
    const fileRow = getStatement('SELECT id FROM files LIMIT 1').get() as { id: number } | undefined;
    const fileId = fileRow?.id ?? 0;
    const result = getStatement('INSERT INTO functions (file_id, name, signature, complexity) VALUES (?, ?, ?, ?)').run(fileId, name, '', 0);
    return Number(result.lastInsertRowid);
  };

  for (const call of calls) {
    try {
      const fromFnId = ensureFunction(call.fromFunctionName);
      const toFnId = ensureFunction(call.toFunctionName);
      if (!fromFnId || !toFnId) {
        errors.push(`Function not found: ${call.fromFunctionName} -> ${call.toFunctionName}`);
        continue;
      }
      const existing = getStatement(`SELECT id, call_count FROM calls WHERE from_function_id = ? AND to_function_id = ? AND workload_id = ?`).get(fromFnId, toFnId, call.workloadId) as { id: number; call_count: number } | undefined;
      if (existing) {
        getStatement(`UPDATE calls SET call_count = call_count + ?, dynamic = 1, static_missed = ? WHERE id = ?`).run(call.callCount ?? 1, call.staticMissed ? 1 : 0, existing.id);
        updated++;
      } else {
        getStatement(`INSERT INTO calls (from_function_id, to_function_id, dynamic, static_missed, call_count, workload_id)
           VALUES (?, ?, 1, ?, ?, ?)`).run(fromFnId, toFnId, call.staticMissed ? 1 : 0, call.callCount ?? 1, call.workloadId);
        inserted++;
      }
    } catch (e) {
      errors.push(`Error processing ${call.fromFunctionName} -> ${call.toFunctionName}: ${e}`);
    }
  }

  return { inserted, updated, errors };
}

export function getDynamicCalls(ctx: KgContext, workloadId: string): { fromFunctionId: number; toFunctionId: number; callCount: number; staticMissed: boolean; workloadId: string; fromFunctionName: string; toFunctionName: string }[] {
  const rows = getStatement(`SELECT c.*, f1.name as from_name, f2.name as to_name
     FROM calls c
     JOIN functions f1 ON c.from_function_id = f1.id
     JOIN functions f2 ON c.to_function_id = f2.id
     WHERE c.workload_id = ? AND c.dynamic = 1`).all(workloadId) as Record<string, SQLOutputValue>[];

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

export function getAllDynamicCalls(_ctx: KgContext): { fromFunctionId: number; toFunctionId: number; callCount: number; staticMissed: boolean; workloadId: string; fromFunctionName: string; toFunctionName: string }[] {
  const rows = getStatement(`SELECT c.*, f1.name as from_name, f2.name as to_name
     FROM calls c
     JOIN functions f1 ON c.from_function_id = f1.id
     JOIN functions f2 ON c.to_function_id = f2.id
     WHERE c.dynamic = 1`).all() as Record<string, SQLOutputValue>[];

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

export function getStaticMissedCalls(_ctx: KgContext): { fromFunctionName: string; toFunctionName: string; workloadId: string; callCount: number; staticMissed: boolean }[] {
  const rows = getStatement(`SELECT c.*, f1.name as from_name, f2.name as to_name
     FROM calls c
     JOIN functions f1 ON c.from_function_id = f1.id
     JOIN functions f2 ON c.to_function_id = f2.id
     WHERE c.dynamic = 1 AND c.static_missed = 1`).all() as Record<string, SQLOutputValue>[];

  return rows.map((r) => ({
    fromFunctionName: (r.from_name as string) || '',
    toFunctionName: (r.to_name as string) || '',
    workloadId: r.workload_id as string,
    callCount: r.call_count as number,
    staticMissed: true,
  }));
}

export function clearDynamicCalls(ctx: KgContext, workloadId: string): number {
  const result = getStatement(`DELETE FROM calls WHERE workload_id = ?`).run(workloadId);
  return Number(result.changes);
}

export function clearAllDynamicCalls(_ctx: KgContext): number {
  const result = getStatement(`DELETE FROM calls WHERE dynamic = 1`).run();
  return Number(result.changes);
}

export function getCoherenceDecisions(ctx: KgContext, fileId: number): { id: number; verdict: string; confidence: number; analyzedAt: string; llmProvider: string | null }[] {
  const rows = getStatement(`
    SELECT id, verdict, confidence, analyzed_at, llm_provider 
    FROM coherence_decisions 
    WHERE file_id = ? 
    ORDER BY analyzed_at DESC
  `).all(fileId) as Record<string, SQLOutputValue>[];

  return rows.map((r) => ({
    id: r.id as number,
    verdict: r.verdict as string,
    confidence: r.confidence as number,
    analyzedAt: r.analyzed_at as string,
    llmProvider: (r.llm_provider as string | null) ?? null,
  }));
}

export function getDependencyGraph(ctx: KgContext, modulePath: string): { nodes: FileInfo[]; edges: { from: string; to: string; kind: string }[] } {
  const allFiles = getAllFiles(ctx);
  const moduleFiles = allFiles.filter((f) => f.relativePath.startsWith(modulePath));
  const moduleFileIds = new Set(moduleFiles.map((f) => f.id));

  const nodes = moduleFiles;
  const edges: { from: string; to: string; kind: string }[] = [];

  for (const file of moduleFiles) {
    const fileImports = getImports(ctx, file.id);
    for (const imp of fileImports) {
      const resolved = resolveImportSource(ctx, imp.source);
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
    if (pathSegments.some(seg => seg === normalizedPattern)) return true;
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

export function getFileByImport(ctx: KgContext, importPath: string, fromFilePath?: string): FileInfo | null {
  let file = resolveImportSource(ctx, importPath);
  if (file) return file;

  if (fromFilePath) {
    const fromFile = getFileByPath(ctx, fromFilePath);
    if (fromFile) {
      const fromDir = fromFile.relativePath.substring(0, fromFile.relativePath.lastIndexOf('/'));
      const resolvedPath = resolve(fromDir, importPath).replace(/\\/g, '/');
      file = resolveImportSource(ctx, resolvedPath);
      if (file) return file;
    }
  }

  return null;
}
