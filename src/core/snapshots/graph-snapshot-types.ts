export const GRAPH_SNAPSHOT_FORMAT = 'projectmind-graph' as const;
export const GRAPH_SNAPSHOT_VERSION = 1 as const;

export interface GraphSnapshotFile {
  path: string;
  language: string;
  sizeBytes: number;
  hash: string;
  cognitiveLoad: number;
}

export interface GraphSnapshotImport {
  fromPath: string;
  source: string;
  kind: string;
  resolved: boolean;
  resolvedPath: string | null;
}

export interface GraphSnapshotCall {
  fromPath: string;
  fromFunction: string;
  toPath: string;
  toFunction: string;
  dynamic: boolean;
  staticMissed: boolean;
  callCount: number;
  workloadId: string | null;
}

export interface GraphSnapshot {
  format: typeof GRAPH_SNAPSHOT_FORMAT;
  formatVersion: typeof GRAPH_SNAPSHOT_VERSION;
  createdAt: string;
  project: { id: number; name: string };
  files: GraphSnapshotFile[];
  imports: GraphSnapshotImport[];
  calls: GraphSnapshotCall[];
  graphHash: string;
}

export interface GraphSnapshotDiff {
  projectChanged: boolean;
  addedFiles: string[];
  removedFiles: string[];
  changedFiles: string[];
  addedImports: GraphSnapshotImport[];
  removedImports: GraphSnapshotImport[];
  addedCalls: GraphSnapshotCall[];
  removedCalls: GraphSnapshotCall[];
}

export interface GraphSnapshotVerification extends GraphSnapshotDiff {
  match: boolean;
  projectMatch: boolean;
  snapshotHash: string;
  currentHash: string;
  limitations: string[];
}
