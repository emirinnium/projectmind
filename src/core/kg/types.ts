export type IntegrityViolationType =
  'missing_file' | 'moved_file' | 'stale_import' | 'stale_function' | 'orphan_node';

/** F23: machine-readable repair suggestion for a violation. */
export type IntegritySuggestedAction = 'delete_node' | 'update_path' | 'relink';

export interface IntegrityViolation {
  type: IntegrityViolationType;
  /** For orphan functions this is the CONTAINING file, never the function name. */
  filePath: string;
  message: string;
  suggestedPath?: string;
  /** F23: id of the affected KG row (files.id, functions.id or imports.id). */
  kgNodeId: string | number;
  /** F23: recommended repair action. */
  suggestedAction: IntegritySuggestedAction;
  /** F23: 0..1 confidence in the detection. */
  confidence: number;
  /** F27: structured stale-import data (importing file) — no message parsing. */
  sourcePath?: string;
  /** F27: the unresolved import specifier. */
  specifier?: string;
  /** F28: orphan function name (proper field, never filePath). */
  functionName?: string;
  /** Extra structured details (functionName, fileId, exported flag, ...). */
  details?: Record<string, unknown>;
}

export interface RepairAction {
  type: IntegrityViolationType;
  filePath: string;
  newPath?: string;
  applied: boolean;
}

export interface IntegrityReport {
  violations: IntegrityViolation[];
  repaired: number;
  orphans: string[];
  timestamp: string;
}
