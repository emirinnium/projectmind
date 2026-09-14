import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { getDatabase } from '../../../storage/database.js';

export type DebtType =
  | 'pattern_drift'
  | 'architectural_drift'
  | 'redundancy'
  | 'agent_conflict'
  | 'complexity'
  | 'code_age'
  | 'cognitive_load'
  | 'change_frequency';
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

export interface DebtReportOptions {
  /** Maximum number of items to return (default: 100, set to 0 for all) */
  limit?: number;
  /** Number of items to skip (for pagination) */
  offset?: number;
  /** Filter by severity */
  severity?: Severity;
  /** Filter by type */
  type?: DebtType;
  /** Include resolved items (default: false) */
  includeResolved?: boolean;
}

export interface DebtReport {
  totalItems: number;
  bySeverity: Record<Severity, number>;
  byType: Record<DebtType, number>;
  coherenceGenomeScore: number;
  items: DebtItem[];
  /** Whether there are more items available */
  hasMore: boolean;
}

/**
 * Handles persistence of debt items to database
 */
export class DebtPersistence {
  private db: DatabaseSync;
  private projectId: number;

  constructor(db?: DatabaseSync, projectId = 1) {
    this.db = db || getDatabase();
    this.projectId = projectId;
  }

  private getStmt(sql: string) {
    return this.db.prepare(sql);
  }
  createDebtItem(opts: {
    type: DebtType;
    description: string;
    severity: Severity;
    suggestion: string;
    reasoningTrace: string[];
    filePath: string | null;
  }): DebtItem {
    const fileId = opts.filePath
      ? (
          this.getStmt(
            'SELECT id FROM files WHERE project_id = ? AND (path = ? OR relative_path = ?) LIMIT 1',
          ).get(this.projectId, opts.filePath, opts.filePath) as { id: number } | undefined
        )?.id
      : null;

    // Deduplicate: descriptions are deterministic per finding
    // ("Potential duplicate code: A vs B", "Circular dependency detected: ..."),
    // so an existing unresolved item with the same type+description is the
    // SAME finding — refresh it instead of inserting another copy.
    const existing = this.getStmt(
      'SELECT id FROM debt_items WHERE project_id = ? AND type = ? AND description = ? AND resolved = 0 LIMIT 1',
    ).get(this.projectId, opts.type, opts.description) as { id: number } | undefined;

    if (existing) {
      this.getStmt(
        `UPDATE debt_items SET detected_at = CURRENT_TIMESTAMP, severity = ?, suggestion = ?, reasoning_trace = ?
         WHERE id = ?`,
      ).run(opts.severity, opts.suggestion, JSON.stringify(opts.reasoningTrace), existing.id);

      return {
        id: existing.id,
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

    const result = this.getStmt(
      `INSERT INTO debt_items 
       (type, description, severity, suggestion, reasoning_trace, file_id, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.type,
      opts.description,
      opts.severity,
      opts.suggestion,
      JSON.stringify(opts.reasoningTrace),
      fileId ?? null,
      this.projectId,
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

  getReport(options: DebtReportOptions = {}): DebtReport {
    const { limit = 100, offset = 0, severity, type, includeResolved = false } = options;

    // Build WHERE clause for filtering
    const conditions: string[] = ['d.project_id = ?'];
    const params: Array<string | number | null> = [this.projectId];

    if (!includeResolved) {
      conditions.push('d.resolved = 0');
    }
    if (severity) {
      conditions.push('d.severity = ?');
      params.push(severity);
    }
    if (type) {
      conditions.push('d.type = ?');
      params.push(type);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count (without pagination)
    const countResult = this.getStmt(
      `SELECT COUNT(*) as count FROM debt_items d ${whereClause}`,
    ).get(...params) as { count: number };
    const totalItems = countResult.count;

    // Get items with pagination
    const items = this.getStmt(
      `SELECT d.*, f.relative_path as file_path 
       FROM debt_items d LEFT JOIN files f ON d.file_id = f.id AND f.project_id = d.project_id
       ${whereClause}
       ORDER BY d.detected_at DESC
       LIMIT ? OFFSET ?`,
    ).all(...params, limit || -1, offset) as Record<string, SQLOutputValue>[];

    // Get severity/type counts (from full dataset, not paginated)
    const severityCounts = this.getStmt(
      `SELECT severity, COUNT(*) as count FROM debt_items d ${whereClause} GROUP BY severity`,
    ).all(...params) as Array<{ severity: Severity; count: number }>;

    const typeCounts = this.getStmt(
      `SELECT type, COUNT(*) as count FROM debt_items d ${whereClause} GROUP BY type`,
    ).all(...params) as Array<{ type: DebtType; count: number }>;

    const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
    const byType: Record<DebtType, number> = {
      pattern_drift: 0,
      architectural_drift: 0,
      redundancy: 0,
      agent_conflict: 0,
      complexity: 0,
      code_age: 0,
      cognitive_load: 0,
      change_frequency: 0,
    };

    for (const { severity: s, count } of severityCounts) {
      bySeverity[s] = count;
    }
    for (const { type: t, count } of typeCounts) {
      byType[t] = count;
    }

    const genomeResult = this.getStmt(
      'SELECT coherence_score FROM project_genome ORDER BY computed_at DESC LIMIT 1',
    ).get() as { coherence_score: number | null } | undefined;

    return {
      totalItems,
      bySeverity,
      byType,
      coherenceGenomeScore: genomeResult?.coherence_score ?? 0.85,
      items: items.map((item) => ({
        id: item.id as number,
        type: item.type as DebtType,
        description: item.description as string,
        severity: item.severity as Severity,
        suggestion: item.suggestion as string,
        reasoningTrace: JSON.parse((item.reasoning_trace as string) || '[]'),
        detectedAt: item.detected_at as string,
        resolved: item.resolved === 1,
        filePath: item.file_path as string | null,
      })),
      hasMore: offset + items.length < totalItems,
    };
  }

  resolveDebt(debtId: number): boolean {
    const result = this.getStmt(
      'UPDATE debt_items SET resolved = 1, resolved_at = CURRENT_TIMESTAMP WHERE id = ? AND project_id = ?',
    ).run(debtId, this.projectId);
    return Number(result.changes) > 0;
  }

  clearAll(): void {
    this.getStmt('DELETE FROM debt_items WHERE project_id = ?').run(this.projectId);
  }

  /**
   * Remove unresolved findings for one detector type before that detector
   * writes a fresh snapshot. Resolved history is intentionally preserved.
   */
  clearUnresolvedType(type: DebtType): void {
    this.getStmt('DELETE FROM debt_items WHERE project_id = ? AND type = ? AND resolved = 0').run(
      this.projectId,
      type,
    );
  }

  /**
   * Batch insert debt items to avoid N+1 queries.
   */
  batchInsertDebtItems(
    items: Array<{
      type: DebtType;
      description: string;
      severity: Severity;
      suggestion: string;
      reasoningTrace: string[];
      filePath: string | null;
    }>,
  ): void {
    if (items.length === 0) return;

    // Start a transaction
    this.db.exec('BEGIN TRANSACTION');

    try {
      for (const item of items) {
        const fileId = item.filePath
          ? (
              this.getStmt(
                'SELECT id FROM files WHERE project_id = ? AND (path = ? OR relative_path = ?) LIMIT 1',
              ).get(this.projectId, item.filePath, item.filePath) as { id: number } | undefined
            )?.id
          : null;

        // Check for existing unresolved item
        const existing = this.getStmt(
          'SELECT id FROM debt_items WHERE project_id = ? AND type = ? AND description = ? AND resolved = 0 LIMIT 1',
        ).get(this.projectId, item.type, item.description) as { id: number } | undefined;

        if (existing) {
          this.getStmt(
            `UPDATE debt_items SET detected_at = CURRENT_TIMESTAMP, severity = ?, suggestion = ?, reasoning_trace = ?
             WHERE id = ?`,
          ).run(item.severity, item.suggestion, JSON.stringify(item.reasoningTrace), existing.id);
        } else {
          this.getStmt(
            `INSERT INTO debt_items 
             (type, description, severity, suggestion, reasoning_trace, file_id, project_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            item.type,
            item.description,
            item.severity,
            item.suggestion,
            JSON.stringify(item.reasoningTrace),
            fileId ?? null,
            this.projectId,
          );
        }
      }

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  clearPatterns(): void {
    this.getStmt('DELETE FROM patterns WHERE project_id = ?').run(this.projectId);
  }
}
