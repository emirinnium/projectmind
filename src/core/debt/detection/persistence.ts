import { getStatement } from '../../../storage/database.js';

export type DebtType = 'pattern_drift' | 'architectural_drift' | 'redundancy' | 'agent_conflict';
export type Severity = 'high' | 'medium' | 'low';

export interface DebtItem {
  id: number;
  type: DebtType;
  description: string;
  severity: Severity;
  suggestion: string;
  reasoningTrace: string[];
  detectedAt: string;
  resolved: boolean;
  filePath: string | null;
}

export interface DebtReport {
  totalItems: number;
  bySeverity: Record<Severity, number>;
  byType: Record<DebtType, number>;
  coherenceGenomeScore: number;
  items: DebtItem[];
}

/**
 * Handles persistence of debt items to database
 */
export class DebtPersistence {
  createDebtItem(opts: {
    type: DebtType;
    description: string;
    severity: Severity;
    suggestion: string;
    reasoningTrace: string[];
    filePath: string | null;
  }): DebtItem {
    const fileId = opts.filePath
      ? (getStatement('SELECT id FROM files WHERE path = ? OR relative_path = ?').get(opts.filePath, opts.filePath) as { id: number } | undefined)?.id
      : null;

    const result = getStatement(
      `INSERT INTO debt_items 
       (type, description, severity, suggestion, reasoning_trace, file_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      opts.type,
      opts.description,
      opts.severity,
      opts.suggestion,
      JSON.stringify(opts.reasoningTrace),
      fileId ?? null
    );

    return {
      id: Number(result.lastInsertRowid),
      type: opts.type,
      description: opts.description,
      severity: opts.severity,
      suggestion: opts.suggestion,
      reasoningTrace: opts.reasoningTrace,
      detectedAt: new Date().toISOString(),
      resolved: false,
      filePath: opts.filePath,
    };
  }

  getReport(): DebtReport {
    const items = getStatement(
      `SELECT d.*, f.relative_path as file_path 
       FROM debt_items d LEFT JOIN files f ON d.file_id = f.id 
       ORDER BY d.detected_at DESC`
    ).all() as Record<string, unknown>[];

    const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
    const byType: Record<DebtType, number> = { pattern_drift: 0, architectural_drift: 0, redundancy: 0, agent_conflict: 0 };

    for (const item of items) {
      const severity = item.severity as Severity;
      const type = item.type as DebtType;
      bySeverity[severity]++;
      byType[type]++;
    }

    const genomeResult = getStatement(
      'SELECT coherence_score FROM project_genome ORDER BY computed_at DESC LIMIT 1'
    ).get() as { coherence_score: number | null } | undefined;

    return {
      totalItems: items.length,
      bySeverity,
      byType,
      coherenceGenomeScore: genomeResult?.coherence_score ?? 0.85,
      items: items.map((item) => ({
        id: item.id as number,
        type: item.type as DebtType,
        description: item.description as string,
        severity: item.severity as Severity,
        suggestion: item.suggestion as string,
        reasoningTrace: JSON.parse(item.reasoning_trace as string || '[]'),
        detectedAt: item.detected_at as string,
        resolved: item.resolved === 1,
        filePath: item.file_path as string | null,
      })),
    };
  }

  resolveDebt(debtId: number): void {
    getStatement('UPDATE debt_items SET resolved = 1, resolved_at = CURRENT_TIMESTAMP WHERE id = ?').run(debtId);
  }

  clearAll(): void {
    getStatement('DELETE FROM debt_items').run();
  }

  clearPatterns(): void {
    getStatement('DELETE FROM patterns').run();
  }
}