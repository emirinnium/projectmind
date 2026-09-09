import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SQLOutputValue } from 'node:sqlite';
import type { KnowledgeGraph } from '../../storage/knowledge-graph.js';
import { normalizePath } from '../../utils/paths.js';
import {
  calculateGraphSnapshotHash,
  graphSnapshotPayload,
  verifyGraphSnapshotAgainstCurrent,
} from './graph-snapshot-diff.js';
import {
  GRAPH_SNAPSHOT_FORMAT,
  GRAPH_SNAPSHOT_VERSION,
  type GraphSnapshot,
  type GraphSnapshotVerification,
} from './graph-snapshot-types.js';

export { GRAPH_SNAPSHOT_FORMAT, GRAPH_SNAPSHOT_VERSION } from './graph-snapshot-types.js';
export type {
  GraphSnapshot,
  GraphSnapshotCall,
  GraphSnapshotDiff,
  GraphSnapshotFile,
  GraphSnapshotImport,
  GraphSnapshotVerification,
} from './graph-snapshot-types.js';
function normalizeSnapshotPath(value: string): string {
  return normalizePath(value).replace(/^\.\//, '');
}

function readNumber(value: SQLOutputValue, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(value: SQLOutputValue): boolean {
  return readNumber(value) === 1;
}

function readString(value: SQLOutputValue, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function currentProjectOrThrow(kg: KnowledgeGraph): { id: number; name: string } {
  const project = kg.getCurrentProject();
  if (!project) throw new Error('No active ProjectMind project is selected.');
  return { id: project.id, name: project.name };
}
/** Build a deterministic, portable snapshot of the active project's graph. */
export function createGraphSnapshot(kg: KnowledgeGraph): GraphSnapshot {
  const project = currentProjectOrThrow(kg);
  const files = kg.getAllFiles().map((file) => ({
    path: normalizeSnapshotPath(file.relativePath || file.path),
    language: file.language || 'unknown',
    sizeBytes: file.sizeBytes,
    hash: file.hash || '',
    cognitiveLoad: file.cognitiveLoad,
  }));

  const importRows = kg.db
    .prepare(
      `SELECT f.relative_path AS from_path, i.source, i.kind, i.resolved, i.resolved_path
       FROM imports i
       JOIN files f ON f.id = i.file_id
       WHERE f.project_id = ?`,
    )
    .all(kg.getCurrentProjectId()) as Record<string, SQLOutputValue>[];
  const imports = importRows.map((row) => ({
    fromPath: normalizeSnapshotPath(readString(row.from_path)),
    source: readString(row.source),
    kind: readString(row.kind, 'import'),
    resolved: readBoolean(row.resolved),
    resolvedPath:
      row.resolved_path === null || row.resolved_path === undefined
        ? null
        : normalizeSnapshotPath(readString(row.resolved_path)),
  }));

  const callRows = kg.db
    .prepare(
      `SELECT f1.relative_path AS from_path, fn1.name AS from_function,
              f2.relative_path AS to_path, fn2.name AS to_function,
              c.dynamic, c.static_missed, c.call_count, c.workload_id
       FROM calls c
       JOIN functions fn1 ON fn1.id = c.from_function_id
       JOIN files f1 ON f1.id = fn1.file_id
       JOIN functions fn2 ON fn2.id = c.to_function_id
       JOIN files f2 ON f2.id = fn2.file_id
       WHERE f1.project_id = ? AND f2.project_id = ?`,
    )
    .all(kg.getCurrentProjectId(), kg.getCurrentProjectId()) as Record<string, SQLOutputValue>[];
  const calls = callRows.map((row) => ({
    fromPath: normalizeSnapshotPath(readString(row.from_path)),
    fromFunction: readString(row.from_function),
    toPath: normalizeSnapshotPath(readString(row.to_path)),
    toFunction: readString(row.to_function),
    dynamic: readBoolean(row.dynamic),
    staticMissed: readBoolean(row.static_missed),
    callCount: readNumber(row.call_count, 1),
    workloadId:
      row.workload_id === null || row.workload_id === undefined
        ? null
        : readString(row.workload_id),
  }));

  const payload = graphSnapshotPayload({ project, files, imports, calls });
  return {
    format: GRAPH_SNAPSHOT_FORMAT,
    formatVersion: GRAPH_SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    ...payload,
    graphHash: calculateGraphSnapshotHash(payload),
  };
}

function assertProjectPath(projectRoot: string, targetPath: string): string {
  const root = resolve(projectRoot);
  const target = isAbsolute(targetPath) ? resolve(targetPath) : resolve(root, targetPath);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Snapshot path escapes the project root: ${targetPath}`);
  }
  return target;
}
/** Write a snapshot inside the project, using a Windows-safe default filename. */
export async function writeGraphSnapshot(
  kg: KnowledgeGraph,
  projectRoot: string,
  outputPath?: string,
): Promise<{ path: string; snapshot: GraphSnapshot }> {
  const snapshot = createGraphSnapshot(kg);
  const safeTimestamp = snapshot.createdAt.replace(/[:.]/g, '-');
  const requestedPath = outputPath ?? `.projectmind/snapshots/graph-${safeTimestamp}.json`;
  const targetPath = assertProjectPath(projectRoot, requestedPath);
  await mkdir(resolve(targetPath, '..'), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return { path: targetPath, snapshot };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`Invalid snapshot field: ${key}`);
  return value;
}
function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`Invalid snapshot field: ${key}`);
  return value;
}
function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  if (typeof record[key] !== 'boolean') throw new Error(`Invalid snapshot field: ${key}`);
  return record[key] as boolean;
}

function parseSnapshot(value: unknown): GraphSnapshot {
  if (!isRecord(value)) throw new Error('Snapshot must be a JSON object.');
  if (value.format !== GRAPH_SNAPSHOT_FORMAT || value.formatVersion !== GRAPH_SNAPSHOT_VERSION) {
    throw new Error(
      `Unsupported graph snapshot format/version: ${String(value.format)}/${String(value.formatVersion)}`,
    );
  }
  const projectValue = value.project;
  if (!isRecord(projectValue)) throw new Error('Invalid snapshot project metadata.');
  const project = {
    id: requiredNumber(projectValue, 'id'),
    name: requiredString(projectValue, 'name'),
  };
  const filesValue = value.files;
  const importsValue = value.imports;
  const callsValue = value.calls;
  if (!Array.isArray(filesValue) || !Array.isArray(importsValue) || !Array.isArray(callsValue)) {
    throw new Error('Snapshot files, imports, and calls must be arrays.');
  }
  const files = filesValue.map((item) => {
    if (!isRecord(item)) throw new Error('Invalid snapshot file entry.');
    return {
      path: requiredString(item, 'path'),
      language: requiredString(item, 'language'),
      sizeBytes: requiredNumber(item, 'sizeBytes'),
      hash: requiredString(item, 'hash'),
      cognitiveLoad: requiredNumber(item, 'cognitiveLoad'),
    };
  });
  const imports = importsValue.map((item) => {
    if (!isRecord(item)) throw new Error('Invalid snapshot import entry.');
    const resolvedPath = item.resolvedPath;
    if (resolvedPath !== null && typeof resolvedPath !== 'string') {
      throw new Error('Invalid snapshot import resolvedPath.');
    }
    return {
      fromPath: requiredString(item, 'fromPath'),
      source: requiredString(item, 'source'),
      kind: requiredString(item, 'kind'),
      resolved: requiredBoolean(item, 'resolved'),
      resolvedPath: resolvedPath as string | null,
    };
  });
  const calls = callsValue.map((item) => {
    if (!isRecord(item)) throw new Error('Invalid snapshot call entry.');
    const workloadId = item.workloadId;
    if (workloadId !== null && typeof workloadId !== 'string') {
      throw new Error('Invalid snapshot call workloadId.');
    }
    return {
      fromPath: requiredString(item, 'fromPath'),
      fromFunction: requiredString(item, 'fromFunction'),
      toPath: requiredString(item, 'toPath'),
      toFunction: requiredString(item, 'toFunction'),
      dynamic: requiredBoolean(item, 'dynamic'),
      staticMissed: requiredBoolean(item, 'staticMissed'),
      callCount: requiredNumber(item, 'callCount'),
      workloadId: workloadId as string | null,
    };
  });
  const createdAt = requiredString(value, 'createdAt');
  const graphHash = requiredString(value, 'graphHash');
  const payload = graphSnapshotPayload({ project, files, imports, calls });
  if (calculateGraphSnapshotHash(payload) !== graphHash) {
    throw new Error('Snapshot graphHash does not match its contents; the file may be corrupted.');
  }
  return {
    format: GRAPH_SNAPSHOT_FORMAT,
    formatVersion: GRAPH_SNAPSHOT_VERSION,
    createdAt,
    ...payload,
    graphHash,
  };
}

export async function readGraphSnapshot(snapshotPath: string): Promise<GraphSnapshot> {
  const raw = await readFile(snapshotPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid graph snapshot JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseSnapshot(parsed);
}

export function verifyGraphSnapshot(
  snapshot: GraphSnapshot,
  kg: KnowledgeGraph,
): GraphSnapshotVerification {
  return verifyGraphSnapshotAgainstCurrent(snapshot, createGraphSnapshot(kg));
}

export { diffGraphSnapshots } from './graph-snapshot-diff.js';
export { calculateGraphSnapshotHash } from './graph-snapshot-diff.js';
