import { stableHash } from '../../utils/hash.js';
import type {
  GraphSnapshot,
  GraphSnapshotCall,
  GraphSnapshotDiff,
  GraphSnapshotFile,
  GraphSnapshotImport,
  GraphSnapshotVerification,
} from './graph-snapshot-types.js';

type SnapshotGraphPayload = Pick<GraphSnapshot, 'project' | 'files' | 'imports' | 'calls'>;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function importSortKey(item: GraphSnapshotImport): string {
  return JSON.stringify([item.fromPath, item.source, item.kind, item.resolved, item.resolvedPath]);
}

function callSortKey(item: GraphSnapshotCall): string {
  return JSON.stringify([
    item.fromPath,
    item.fromFunction,
    item.toPath,
    item.toFunction,
    item.dynamic,
    item.staticMissed,
    item.callCount,
    item.workloadId,
  ]);
}

/** Canonicalize graph collections so snapshot hashes are independent of SQL row order. */
export function graphSnapshotPayload(snapshot: SnapshotGraphPayload): SnapshotGraphPayload {
  return {
    project: { id: snapshot.project.id, name: snapshot.project.name },
    files: [...snapshot.files].sort((a, b) => compareStrings(a.path, b.path)),
    imports: [...snapshot.imports].sort(
      (a, b) =>
        compareStrings(importSortKey(a), importSortKey(b)) ||
        compareStrings(
          `${a.fromPath}\u0000${a.source}\u0000${a.kind}\u0000${a.resolvedPath ?? ''}`,
          `${b.fromPath}\u0000${b.source}\u0000${b.kind}\u0000${b.resolvedPath ?? ''}`,
        ),
    ),
    calls: [...snapshot.calls].sort(
      (a, b) =>
        compareStrings(callSortKey(a), callSortKey(b)) ||
        compareStrings(
          `${a.fromPath}\u0000${a.fromFunction}\u0000${a.toPath}\u0000${a.toFunction}\u0000${a.workloadId ?? ''}`,
          `${b.fromPath}\u0000${b.fromFunction}\u0000${b.toPath}\u0000${b.workloadId ?? ''}`,
        ),
    ),
  };
}

export function calculateGraphSnapshotHash(snapshot: SnapshotGraphPayload): string {
  return stableHash(JSON.stringify(graphSnapshotPayload(snapshot)));
}

function fileSignature(file: GraphSnapshotFile): string {
  return JSON.stringify([file.path, file.language, file.sizeBytes, file.hash, file.cognitiveLoad]);
}

function importSignature(item: GraphSnapshotImport): string {
  return JSON.stringify([item.fromPath, item.source, item.kind, item.resolved, item.resolvedPath]);
}

function callSignature(item: GraphSnapshotCall): string {
  return JSON.stringify([
    item.fromPath,
    item.fromFunction,
    item.toPath,
    item.toFunction,
    item.dynamic,
    item.staticMissed,
    item.callCount,
    item.workloadId,
  ]);
}

function diffEntries<T>(
  left: T[],
  right: T[],
  key: (item: T) => string,
): { added: T[]; removed: T[] } {
  const leftMap = new Map(left.map((item) => [key(item), item]));
  const rightMap = new Map(right.map((item) => [key(item), item]));
  return {
    added: [...rightMap.entries()]
      .filter(([entryKey]) => !leftMap.has(entryKey))
      .map(([, item]) => item),
    removed: [...leftMap.entries()]
      .filter(([entryKey]) => !rightMap.has(entryKey))
      .map(([, item]) => item),
  };
}

function diffSnapshotPayloads(left: GraphSnapshot, right: GraphSnapshot): GraphSnapshotDiff {
  const leftFiles = new Map(left.files.map((file) => [file.path, file]));
  const rightFiles = new Map(right.files.map((file) => [file.path, file]));
  const addedFiles = [...rightFiles.keys()]
    .filter((path) => !leftFiles.has(path))
    .sort(compareStrings);
  const removedFiles = [...leftFiles.keys()]
    .filter((path) => !rightFiles.has(path))
    .sort(compareStrings);
  const changedFiles = [...leftFiles.keys()]
    .filter(
      (path) =>
        rightFiles.has(path) &&
        fileSignature(leftFiles.get(path)!) !== fileSignature(rightFiles.get(path)!),
    )
    .sort(compareStrings);
  const imports = diffEntries(left.imports, right.imports, importSignature);
  const calls = diffEntries(left.calls, right.calls, callSignature);
  return {
    projectChanged:
      left.project.id !== right.project.id || left.project.name !== right.project.name,
    addedFiles,
    removedFiles,
    changedFiles,
    addedImports: imports.added,
    removedImports: imports.removed,
    addedCalls: calls.added,
    removedCalls: calls.removed,
  };
}

export function diffGraphSnapshots(left: GraphSnapshot, right: GraphSnapshot): GraphSnapshotDiff {
  return diffSnapshotPayloads(left, right);
}

export function verifyGraphSnapshotAgainstCurrent(
  snapshot: GraphSnapshot,
  current: GraphSnapshot,
): GraphSnapshotVerification {
  const diff = diffSnapshotPayloads(snapshot, current);
  const projectMatch = !diff.projectChanged;
  const recalculatedSnapshotHash = calculateGraphSnapshotHash(snapshot);
  const snapshotIntegrityMatch = snapshot.graphHash === recalculatedSnapshotHash;
  const match =
    projectMatch && snapshotIntegrityMatch && recalculatedSnapshotHash === current.graphHash;
  const limitations: string[] = [
    'Verification compares the indexed graph with the snapshot; it does not prove runtime behavior.',
  ];
  if (!snapshotIntegrityMatch)
    limitations.push('Snapshot graphHash does not match the supplied snapshot contents.');
  if (!projectMatch)
    limitations.push('Snapshot and active graph belong to different project identities.');
  if (!match) {
    limitations.push(
      'Graph differences require a fresh scan before downstream analysis can be trusted.',
    );
  }
  return {
    ...diff,
    match,
    projectMatch,
    snapshotHash: snapshot.graphHash,
    currentHash: current.graphHash,
    limitations,
  };
}
