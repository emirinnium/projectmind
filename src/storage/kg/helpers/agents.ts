import { getStatement } from '../../database.js';
import type { SQLOutputValue } from 'node:sqlite';
import type { MemoryEntry, AgentSession } from '../types.js';
import type { KgContext } from './context.js';
import {
  computeTeamMemoryStore,
  type TeamMemoryStoreComputation,
  type TeamMemoryRowView,
} from '../../../core/team-memory/merge.js';

export function startAgentSession(ctx: KgContext, agentName: string): number {
  const result = getStatement('INSERT INTO agent_sessions (agent_name) VALUES (?)').run(agentName);
  return Number(result.lastInsertRowid);
}

export function endAgentSession(ctx: KgContext, sessionId: number): void {
  getStatement(
    'UPDATE agent_sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(sessionId);
}

export function storeMemory(ctx: KgContext, sessionId: number, scope: string, key: string, value: string): void {
  getStatement(
    `INSERT INTO agent_memory (session_id, scope, key, value) VALUES (?, ?, ?, ?)`
  ).run(sessionId, scope, key, value);
}

export function getMemory(ctx: KgContext, scope: string, key?: string): MemoryEntry[] {
  // Respect expires_at exactly like MemoryRepository does — the two data
  // access layers previously diverged and expired memories leaked through
  // this path.
  const now = new Date().toISOString();
  const sql = key
    ? 'SELECT * FROM agent_memory WHERE scope = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC'
    : 'SELECT * FROM agent_memory WHERE scope = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC';
  const rows = (key
    ? getStatement(sql).all(scope, key, now)
    : getStatement(sql).all(scope, now)
  ) as Record<string, SQLOutputValue>[];
  return rows.map((r) => ({
    id: r.id as number,
    sessionId: r.session_id as number,
    scope: r.scope as string,
    key: r.key as string,
    value: (() => { try { return JSON.parse(r.value as string); } catch { return r.value as string; } })(),
    createdAt: r.created_at as string,
  }));
}

export function storeTeamMemory(ctx: KgContext, params: { agentName: string; scope: string; key: string; value: string; isPublic: boolean }): TeamMemoryStoreComputation {
  const existingRow = getStatement('SELECT value, base_value FROM team_memories WHERE scope = ? AND key = ?')
    .get(params.scope, params.key) as { value: SQLOutputValue; base_value: SQLOutputValue | null } | undefined;

  const existing = existingRow
    ? {
        value: existingRow.value as string,
        baseValue: existingRow.base_value as string | null,
      }
    : null;

  const decision = computeTeamMemoryStore(existing, params.value);

  if (decision.shouldWrite) {
    // Single atomic UPSERT: value + base_value (the ancestor for the next write).
    getStatement(`INSERT INTO team_memories (agent_name, scope, key, value, base_value, is_public)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET
         value = excluded.value,
         base_value = excluded.base_value,
         agent_name = excluded.agent_name,
         is_public = excluded.is_public,
         updated_at = CURRENT_TIMESTAMP`).run(
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

export function getTeamMemories(ctx: KgContext, params: { scope: string; agentName: string }): TeamMemoryRowView[] {
  const rows = getStatement(`SELECT * FROM team_memories
     WHERE scope = ? AND (is_public = 1 OR agent_name = ?)
     ORDER BY updated_at DESC`).all(params.scope, params.agentName) as Record<string, SQLOutputValue>[];

  return rows.map(mapTeamMemoryRow);
}

/** Cross-scope retrieval for semantic search: everything the viewer may see. */
export function getAllTeamMemories(ctx: KgContext, viewerAgentName: string): TeamMemoryRowView[] {
  const rows = getStatement(`SELECT * FROM team_memories
     WHERE is_public = 1 OR agent_name = ?
     ORDER BY updated_at DESC
     LIMIT 2000`).all(viewerAgentName) as Record<string, SQLOutputValue>[];
  return rows.map(mapTeamMemoryRow);
}

function mapTeamMemoryRow(r: Record<string, SQLOutputValue>): TeamMemoryRowView {
  return {
    id: r.id as number,
    agentName: r.agent_name as string,
    scope: r.scope as string,
    key: r.key as string,
    value: (() => { try { return JSON.parse(r.value as string); } catch { return r.value as string; } })(),
    baseValue: r.base_value as string | null,
    isPublic: (r.is_public as number) === 1,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function getAgentSessions(ctx: KgContext, agentName?: string, limit: number = 50): AgentSession[] {
  const sql = agentName
    ? 'SELECT * FROM agent_sessions WHERE agent_name = ? ORDER BY started_at DESC LIMIT ?'
    : 'SELECT * FROM agent_sessions ORDER BY started_at DESC LIMIT ?';
  const rows = (agentName
    ? getStatement(sql).all(agentName, limit)
    : getStatement(sql).all(limit)
  ) as Record<string, SQLOutputValue>[];
  return rows.map((r) => ({
    id: r.id as number,
    agentName: r.agent_name as string,
    startedAt: r.started_at as string,
    endedAt: r.ended_at as string | null,
    contextHash: r.context_hash as string,
    decisions: r.decisions ? JSON.parse(r.decisions as string) : null,
    fingerprint: r.fingerprint ? JSON.parse(r.fingerprint as string) : null,
  }));
}
