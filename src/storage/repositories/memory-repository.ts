import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { getDatabase } from '../database.js';
import {
  computeTeamMemoryStore,
  type TeamMemoryRowView,
  type TeamMemoryStoreComputation,
} from '../../core/team-memory/merge.js';

export interface MemoryEntry {
  id: number;
  sessionId: number;
  scope: string;
  key: string;
  value: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface AgentSession {
  id: number;
  agentName: string;
  startedAt: string;
  endedAt: string | null;
}

/**
 * Repository for agent memory and session operations.
 */
export class MemoryRepository {
  constructor(private readonly db: DatabaseSync = getDatabase()) {}

  startSession(agentName: string): number {
    const result = this.db.prepare('INSERT INTO agent_sessions (agent_name) VALUES (?)').run(agentName);
    return Number(result.lastInsertRowid);
  }

  endSession(sessionId: number): void {
    this.db.prepare('UPDATE agent_sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ?').run(sessionId);
  }

  getSessions(agentName?: string, limit: number = 50): AgentSession[] {
    if (agentName) {
      const rows = this.db.prepare('SELECT * FROM agent_sessions WHERE agent_name = ? ORDER BY started_at DESC LIMIT ?')
        .all(agentName, limit) as Record<string, SQLOutputValue>[];
      return rows.map((r) => this.mapSession(r));
    } else {
      const rows = this.db.prepare('SELECT * FROM agent_sessions ORDER BY started_at DESC LIMIT ?')
        .all(limit) as Record<string, SQLOutputValue>[];
      return rows.map((r) => this.mapSession(r));
    }
  }

  storeMemory(sessionId: number, scope: string, key: string, value: string, expiresAt?: string): void {
    this.db.prepare(
      'INSERT INTO agent_memory (session_id, scope, key, value, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(sessionId, scope, key, value, expiresAt || null);
  }

  /**
   * Delete expired memories. Returns the number of deleted rows.
   */
  purgeExpiredMemories(): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      'DELETE FROM agent_memory WHERE expires_at IS NOT NULL AND expires_at <= ?'
    ).run(now);
    return Number(result.changes);
  }

  getMemory(scope: string, key?: string): MemoryEntry[] {
    const now = new Date().toISOString();
    if (key) {
      const rows = this.db.prepare(
        'SELECT * FROM agent_memory WHERE scope = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC'
      ).all(scope, key, now) as Record<string, SQLOutputValue>[];
      return rows.map((r) => this.mapMemory(r));
    } else {
      const rows = this.db.prepare(
        'SELECT * FROM agent_memory WHERE scope = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC'
      ).all(scope, now) as Record<string, SQLOutputValue>[];
      return rows.map((r) => this.mapMemory(r));
    }
  }

  storeTeamMemory(params: {
    agentName: string;
    scope: string;
    key: string;
    value: string;
    isPublic?: boolean;
  }): TeamMemoryStoreComputation {
    const existingRow = this.db.prepare('SELECT value, base_value FROM team_memories WHERE scope = ? AND key = ?')
      .get(params.scope, params.key) as { value: SQLOutputValue; base_value: SQLOutputValue | null } | undefined;

    const existing = existingRow
      ? {
          value: existingRow.value as string,
          baseValue: existingRow.base_value as string | null,
        }
      : null;

    const decision = computeTeamMemoryStore(existing, params.value);

    if (decision.shouldWrite) {
      this.db.prepare(
        `INSERT INTO team_memories (agent_name, scope, key, value, base_value, is_public)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET
           value = excluded.value,
           base_value = excluded.base_value,
           agent_name = excluded.agent_name,
           is_public = excluded.is_public,
           updated_at = CURRENT_TIMESTAMP`
      ).run(
        params.agentName,
        params.scope,
        params.key,
        decision.storedValue,
        decision.nextBaseValue,
        params.isPublic ? 1 : 0
      );
    }

    return decision;
  }

  getTeamMemories(params: { scope: string; agentName: string }): TeamMemoryRowView[] {
    const rows = this.db.prepare(
      `SELECT * FROM team_memories
       WHERE scope = ? AND (is_public = 1 OR agent_name = ?)
       ORDER BY updated_at DESC`
    ).all(params.scope, params.agentName) as Record<string, SQLOutputValue>[];

    return rows.map((r) => ({
      id: r.id as number,
      agentName: r.agent_name as string,
      scope: r.scope as string,
      key: r.key as string,
      value: r.value as string,
      baseValue: r.base_value as string | null,
      isPublic: (r.is_public as number) === 1,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }));
  }

  private mapSession(row: Record<string, SQLOutputValue>): AgentSession {
    return {
      id: row.id as number,
      agentName: row.agent_name as string,
      startedAt: row.started_at as string,
      endedAt: (row.ended_at as string | null) ?? null,
    };
  }

  private mapMemory(row: Record<string, SQLOutputValue>): MemoryEntry {
    return {
      id: row.id as number,
      sessionId: row.session_id as number,
      scope: row.scope as string,
      key: row.key as string,
      value: (() => { try { return JSON.parse(row.value as string); } catch { return row.value as string; } })(),
      createdAt: row.created_at as string,
      expiresAt: (row.expires_at as string | null) ?? null,
    };
  }

}
