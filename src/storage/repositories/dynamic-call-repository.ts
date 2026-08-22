import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../database.js';

export interface DynamicCall {
  fromFunctionId: number;
  toFunctionId: number;
  callCount: number;
  staticMissed: boolean;
  workloadId: string;
  fromFunctionName: string;
  toFunctionName: string;
}

/**
 * Repository for dynamic call tracing operations.
 */
export class DynamicCallRepository {
  constructor(private readonly db: DatabaseSync = getDatabase()) {}

  ingest(calls: Array<{
    fromFunctionName: string;
    toFunctionName: string;
    workloadId: string;
    callCount?: number;
    staticMissed?: boolean;
  }>): { inserted: number; updated: number; errors: string[] } {
    let inserted = 0;
    let updated = 0;
    const errors: string[] = [];

    const ensureFunction = (name: string): number | null => {
      const existing = this.db.prepare('SELECT id FROM functions WHERE name = ? LIMIT 1').get(name) as { id: number } | undefined;
      if (existing) return existing.id;

      // Find any valid file_id to satisfy FK constraint
      const fileRow = this.db.prepare('SELECT id FROM files LIMIT 1').get() as { id: number } | undefined;
      const fileId = fileRow?.id;
      
      if (!fileId) {
        // No files exist yet; cannot create function with valid FK
        return null;
      }
      
      const result = this.db.prepare(
        'INSERT INTO functions (file_id, name, signature, complexity) VALUES (?, ?, ?, ?)'
      ).run(fileId, name, '', 0);
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

        const existing = this.db.prepare(
          'SELECT id, call_count FROM calls WHERE from_function_id = ? AND to_function_id = ? AND workload_id = ?'
        ).get(fromFnId, toFnId, call.workloadId) as { id: number; call_count: number } | undefined;

        if (existing) {
          this.db.prepare(
            'UPDATE calls SET call_count = call_count + ?, dynamic = 1, static_missed = ? WHERE id = ?'
          ).run(call.callCount ?? 1, call.staticMissed ? 1 : 0, existing.id);
          updated++;
        } else {
          this.db.prepare(
            'INSERT INTO calls (from_function_id, to_function_id, dynamic, static_missed, call_count, workload_id) VALUES (?, ?, 1, ?, ?, ?)'
          ).run(fromFnId, toFnId, call.staticMissed ? 1 : 0, call.callCount ?? 1, call.workloadId);
          inserted++;
        }
      } catch (e) {
        errors.push(`Error processing ${call.fromFunctionName} -> ${call.toFunctionName}: ${e}`);
      }
    }

    return { inserted, updated, errors };
  }

  getByWorkload(workloadId: string): DynamicCall[] {
    const rows = this.db.prepare(
      `SELECT c.*, f1.name as from_name, f2.name as to_name
       FROM calls c
       JOIN functions f1 ON c.from_function_id = f1.id
       JOIN functions f2 ON c.to_function_id = f2.id
       WHERE c.workload_id = ? AND c.dynamic = 1`
    ).all(workloadId) as Record<string, unknown>[];

    return rows.map((r) => this.mapRow(r));
  }

  getAll(): DynamicCall[] {
    const rows = this.db.prepare(
      `SELECT c.*, f1.name as from_name, f2.name as to_name
       FROM calls c
       JOIN functions f1 ON c.from_function_id = f1.id
       JOIN functions f2 ON c.to_function_id = f2.id
       WHERE c.dynamic = 1`
    ).all() as Record<string, unknown>[];

    return rows.map((r) => this.mapRow(r));
  }

  getStaticMissed(): DynamicCall[] {
    const rows = this.db.prepare(
      `SELECT c.*, f1.name as from_name, f2.name as to_name
       FROM calls c
       JOIN functions f1 ON c.from_function_id = f1.id
       JOIN functions f2 ON c.to_function_id = f2.id
       WHERE c.dynamic = 1 AND c.static_missed = 1`
    ).all() as Record<string, unknown>[];

    return rows.map((r) => this.mapRow(r));
  }

  clearByWorkload(workloadId: string): number {
    const result = this.db.prepare('DELETE FROM calls WHERE workload_id = ?').run(workloadId);
    return Number(result.changes);
  }

  clearAll(): number {
    const result = this.db.prepare('DELETE FROM calls WHERE dynamic = 1').run();
    return Number(result.changes);
  }

  private mapRow(row: Record<string, unknown>): DynamicCall {
    return {
      fromFunctionId: row.from_function_id as number,
      toFunctionId: row.to_function_id as number,
      callCount: row.call_count as number,
      staticMissed: (row.static_missed as number) === 1,
      workloadId: row.workload_id as string,
      fromFunctionName: (row.from_name as string) || '',
      toFunctionName: (row.to_name as string) || '',
    };
  }
}
