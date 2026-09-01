import type { SQLOutputValue } from 'node:sqlite';
import type { KgContext } from './context.js';

/**
 * Advisory multi-agent file locks.
 *
 * Soft coordination layer: a lock does NOT prevent writes (this is a local
 * analysis DB, not a VCS) — it lets Agent B see "Agent A is working on this
 * file right now" BEFORE both edit the same region and collide. Locks carry
 * a TTL so crashed/abandoned agents cannot deadlock a file forever; every
 * read path purges expired rows first.
 */

export interface FileLock {
  id: number;
  filePath: string;
  agentName: string;
  reason: string | null;
  acquiredAt: string;
  expiresAt: string;
}

/** Delete expired locks; returns how many were purged. */
export function purgeExpiredLocks(ctx: KgContext): number {
  const result = ctx.db
    .prepare('DELETE FROM agent_file_locks WHERE expires_at <= CURRENT_TIMESTAMP')
    .run();
  return Number(result.changes ?? 0);
}

function rowToLock(row: Record<string, SQLOutputValue>): FileLock {
  return {
    id: Number(row.id),
    filePath: String(row.file_path),
    agentName: String(row.agent_name),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    acquiredAt: String(row.acquired_at),
    expiresAt: String(row.expires_at),
  };
}

export interface AcquireResult {
  status: 'acquired' | 'held';
  /** Present when status='held': who owns it and until when. */
  heldBy?: FileLock;
  lock?: FileLock;
}

/**
 * Try to lock one file for an agent. UNIQUE(file_path) makes this atomic;
 * on conflict the existing holder's info comes back instead of throwing.
 */
export function acquireFileLock(
  ctx: KgContext,
  filePath: string,
  agentName: string,
  options: { ttlMinutes?: number; reason?: string } = {},
): AcquireResult {
  purgeExpiredLocks(ctx);

  const ttlMinutes = Math.max(1, Math.min(24 * 60, Math.floor(options.ttlMinutes ?? 30)));
  const existing = ctx.db
    .prepare(
      'SELECT id, file_path, agent_name, reason, acquired_at, expires_at FROM agent_file_locks WHERE file_path = ?',
    )
    .get(filePath) as Record<string, SQLOutputValue> | undefined;

  if (existing) {
    const lock = rowToLock(existing);
    // Re-acquire by the SAME agent refreshes the TTL.
    if (lock.agentName === agentName) {
      ctx.db
        .prepare(
          "UPDATE agent_file_locks SET expires_at = datetime('now', '+' || ? || ' minutes'), reason = COALESCE(?, reason) WHERE id = ?",
        )
        .run(String(ttlMinutes), options.reason ?? null, lock.id);
      return { status: 'acquired', lock: { ...lock, expiresAt: lock.expiresAt } };
    }
    return { status: 'held', heldBy: lock };
  }

  const result = ctx.db
    .prepare(
      "INSERT INTO agent_file_locks (file_path, agent_name, reason, expires_at) VALUES (?, ?, ?, datetime('now', '+' || ? || ' minutes'))",
    )
    .run(filePath, agentName, options.reason ?? null, String(ttlMinutes));

  const created = ctx.db
    .prepare(
      'SELECT id, file_path, agent_name, reason, acquired_at, expires_at FROM agent_file_locks WHERE id = ?',
    )
    .get(Number(result.lastInsertRowid)) as Record<string, SQLOutputValue>;

  return { status: 'acquired', lock: rowToLock(created) };
}

export interface ReleaseResult {
  status: 'released' | 'not-held' | 'not-found';
  lock?: FileLock;
}

/** Release a lock. Only the owning agent may release it. */
export function releaseFileLock(
  ctx: KgContext,
  filePath: string,
  agentName: string,
): ReleaseResult {
  purgeExpiredLocks(ctx);

  const row = ctx.db
    .prepare(
      'SELECT id, file_path, agent_name, reason, acquired_at, expires_at FROM agent_file_locks WHERE file_path = ?',
    )
    .get(filePath) as Record<string, SQLOutputValue> | undefined;

  if (!row) return { status: 'not-found' };
  const lock = rowToLock(row);
  if (lock.agentName !== agentName) return { status: 'not-held', lock };

  ctx.db.prepare('DELETE FROM agent_file_locks WHERE id = ?').run(lock.id);
  return { status: 'released', lock };
}

/** All live locks, optionally filtered to one agent. Expired rows purged first. */
export function getActiveLocks(ctx: KgContext, agentName?: string): FileLock[] {
  purgeExpiredLocks(ctx);
  const rows = agentName
    ? (ctx.db
        .prepare(
          'SELECT id, file_path, agent_name, reason, acquired_at, expires_at FROM agent_file_locks WHERE agent_name = ? ORDER BY acquired_at DESC LIMIT 200',
        )
        .all(agentName) as Record<string, SQLOutputValue>[])
    : (ctx.db
        .prepare(
          'SELECT id, file_path, agent_name, reason, acquired_at, expires_at FROM agent_file_locks ORDER BY acquired_at DESC LIMIT 500',
        )
        .all() as Record<string, SQLOutputValue>[]);
  return rows.map(rowToLock);
}

export interface ConflictReport {
  free: string[];
  conflicts: Array<{ filePath: string; heldBy: string; reason: string | null; expiresAt: string }>;
}

/**
 * Check a batch of files before editing: which are free, which are locked
 * by OTHER agents. Own locks are reported as free (agent may proceed).
 */
export function checkFileConflicts(
  ctx: KgContext,
  filePaths: string[],
  agentName: string,
): ConflictReport {
  purgeExpiredLocks(ctx);
  const report: ConflictReport = { free: [], conflicts: [] };

  for (const filePath of filePaths) {
    const row = ctx.db
      .prepare(
        'SELECT id, file_path, agent_name, reason, acquired_at, expires_at FROM agent_file_locks WHERE file_path = ?',
      )
      .get(filePath) as Record<string, SQLOutputValue> | undefined;

    if (!row || row.agent_name === agentName) {
      report.free.push(filePath);
    } else {
      report.conflicts.push({
        filePath,
        heldBy: String(row.agent_name),
        reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
        expiresAt: String(row.expires_at),
      });
    }
  }
  return report;
}
