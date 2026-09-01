// Canonical debt type declarations live in persistence.ts — re-exported here
// to keep this module's public surface unchanged (no duplicate declarations).
import type { FileInfo } from '@/storage/knowledge-graph.ts';
import type { DebtType, Severity, DebtItem, DebtReport } from './persistence.ts';
export { DebtType, Severity, DebtItem, DebtReport };
import type { GenomeBreakdown } from './genome.ts';
export { GenomeBreakdown };
import type { CacheStats } from '../../cache/types.ts';

/**
 * Interface for redundancy detection modules.
 * Extracted to reduce coupling and enable dependency injection.
 */
export interface RedundancyDetector {
  getFileEmbeddings(fileIds: number[]): Map<number, number[]>;
  findSimilarFiles(
    target: FileInfo,
    targetEmbedding: number[],
    allFiles: FileInfo[],
    embeddings: Map<number, number[]>,
  ): Promise<FileInfo[]>;
  getCacheStats(): CacheStats | { error: string };
}

/**
 * Interface for pattern drift detection modules.
 * Extracted to reduce coupling and enable dependency injection.
 */
export interface PatternDriftDetector {
  detect(file: FileInfo, content: string): Promise<DebtItem[]>;
}

/**
 * Interface for architectural drift detection modules.
 * Extracted to reduce coupling and enable dependency injection.
 */
export interface ArchitecturalDriftDetector {
  detect(files: FileInfo[]): Promise<DebtItem[]>;
}

/**
 * Interface for debt persistence operations.
 * Extracted to reduce coupling and enable dependency injection.
 */
export interface DebtPersistence {
  createDebtItem(opts: {
    type: DebtType;
    description: string;
    severity: Severity;
    suggestion: string;
    reasoningTrace: string[];
    filePath: string | null;
  }): DebtItem;

  getReport(options?: {
    limit?: number;
    offset?: number;
    severity?: Severity;
    type?: DebtType;
    includeResolved?: boolean;
  }): DebtReport;

  resolveDebt(debtId: number): void;

  clearAll(): void;

  clearPatterns(): void;

  batchInsertDebtItems(
    items: Array<{
      type: DebtType;
      description: string;
      severity: Severity;
      suggestion: string;
      reasoningTrace: string[];
      filePath: string | null;
    }>,
  ): void;
}

/**
 * Interface for genome computation modules.
 * Extracted to reduce coupling and enable dependency injection.
 */
export interface GenomeComputer {
  compute(): { genomeData: string; coherenceScore: number; breakdown: GenomeBreakdown };
}
