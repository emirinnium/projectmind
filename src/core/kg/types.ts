export type IntegrityViolationType =
  | 'missing_file'
  | 'moved_file'
  | 'stale_import'
  | 'orphan_node';

export interface IntegrityViolation {
  type: IntegrityViolationType;
  filePath: string;
  message: string;
  suggestedPath?: string;
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
