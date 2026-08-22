import { getStatement } from '../../database.js';
import type { MemoryEntry, AgentSession } from '../types.js';
import type { KgContext } from './context.js';

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

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
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    sessionId: r.session_id as number,
    scope: r.scope as string,
    key: r.key as string,
    value: tryParseJson(r.value as string),
    createdAt: r.created_at as string,
  }));
}

export function storeTeamMemory(ctx: KgContext, params: { agentName: string; scope: string; key: string; value: string; isPublic: boolean }): void {
  getStatement(`INSERT INTO team_memories (agent_name, scope, key, value, is_public)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET
       value = excluded.value,
       agent_name = excluded.agent_name,
       is_public = excluded.is_public,
       updated_at = CURRENT_TIMESTAMP`).run(params.agentName, params.scope, params.key, params.value, params.isPublic ? 1 : 0);
}

export function getTeamMemories(ctx: KgContext, params: { scope: string; agentName: string }): { id: number; agentName: string; scope: string; key: string; value: string; isPublic: boolean; createdAt: string; updatedAt: string }[] {
  const rows = getStatement(`SELECT * FROM team_memories
     WHERE scope = ? AND (is_public = 1 OR agent_name = ?)
     ORDER BY updated_at DESC`).all(params.scope, params.agentName) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as number,
    agentName: r.agent_name as string,
    scope: r.scope as string,
    key: r.key as string,
    value: r.value as string,
    isPublic: (r.is_public as number) === 1,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}

export function getAgentSessions(ctx: KgContext, agentName?: string, limit: number = 50): AgentSession[] {
  const sql = agentName
    ? 'SELECT * FROM agent_sessions WHERE agent_name = ? ORDER BY started_at DESC LIMIT ?'
    : 'SELECT * FROM agent_sessions ORDER BY started_at DESC LIMIT ?';
  const rows = (agentName
    ? getStatement(sql).all(agentName, limit)
    : getStatement(sql).all(limit)
  ) as Record<string, unknown>[];
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
