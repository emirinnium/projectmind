import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { reportSuppressedError } from '../../utils/errors.js';

export type ReplayEventType = 'scan' | 'context' | 'review' | 'edit' | 'decision';
export type ReplayStatus = 'recorded' | 'diverged' | 'unavailable';

export interface ReplayEventInput {
  sessionId?: number;
  eventType: ReplayEventType;
  toolName: string;
  filePath?: string;
  sourceHash?: string;
  graphHash?: string;
  policyVersion?: string;
  toolVersion?: string;
  outcome: Record<string, string | number | boolean | null>;
}

export interface ReplayEvent extends ReplayEventInput {
  id: number;
  projectId: number;
  createdAt: string;
  eventHash: string;
}

export interface ReplayComparison extends ReplayEvent {
  status: ReplayStatus;
  reason?: string;
}

export interface ReplayTimelineSummary {
  sessionId: number | null;
  eventCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  durationMs: number | null;
  byEventType: Partial<Record<ReplayEventType, number>>;
  byStatus: Partial<Record<ReplayStatus, number>>;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS replay_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  session_id INTEGER,
  event_type TEXT NOT NULL CHECK(event_type IN ('scan', 'context', 'review', 'edit', 'decision')),
  tool_name TEXT NOT NULL,
  file_path TEXT,
  source_hash TEXT CHECK(source_hash IS NULL OR length(source_hash) = 64),
  graph_hash TEXT CHECK(graph_hash IS NULL OR length(graph_hash) = 64),
  policy_version TEXT,
  tool_version TEXT,
  outcome TEXT NOT NULL DEFAULT '{}',
  event_hash TEXT NOT NULL UNIQUE CHECK(length(event_hash) = 64),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_replay_events_project_file
  ON replay_events(project_id, file_path, id);
CREATE INDEX IF NOT EXISTS idx_replay_events_project_session
  ON replay_events(project_id, session_id, id);
CREATE TRIGGER IF NOT EXISTS replay_events_no_update
  BEFORE UPDATE ON replay_events
  BEGIN
    SELECT RAISE(ABORT, 'replay_events is append-only');
  END;
CREATE TRIGGER IF NOT EXISTS replay_events_no_delete
  BEFORE DELETE ON replay_events
  BEGIN
    SELECT RAISE(ABORT, 'replay_events is append-only');
  END;
`;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function hashEvent(input: ReplayEventInput, projectId: number, createdAt: string): string {
  return createHash('sha256')
    .update(canonical({ ...input, projectId, createdAt }))
    .digest('hex');
}

function safeOutcome(value: Record<string, string | number | boolean | null>): string {
  const entries = Object.entries(value).slice(0, 32);
  return JSON.stringify(Object.fromEntries(entries));
}

/** Payload-free, project-scoped replay metadata store. */
export class AgentReplayStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly projectId: number,
  ) {
    // This makes the API safe on a partial/legacy in-memory DB. Production
    // databases also receive the equivalent versioned migration.
    this.db.exec(CREATE_TABLE_SQL);
  }

  append(input: ReplayEventInput): ReplayEvent {
    const createdAt = new Date().toISOString();
    const eventHash = hashEvent(input, this.projectId, createdAt);
    const result = this.db
      .prepare(
        `INSERT INTO replay_events
          (project_id, session_id, event_type, tool_name, file_path, source_hash,
           graph_hash, policy_version, tool_version, outcome, event_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.projectId,
        input.sessionId ?? null,
        input.eventType,
        input.toolName,
        input.filePath ?? null,
        input.sourceHash ?? null,
        input.graphHash ?? null,
        input.policyVersion ?? null,
        input.toolVersion ?? null,
        safeOutcome(input.outcome),
        eventHash,
        createdAt,
      );
    return {
      ...input,
      id: Number(result.lastInsertRowid),
      projectId: this.projectId,
      createdAt,
      eventHash,
    };
  }

  list(options: { filePath?: string; sessionId?: number; limit?: number } = {}): ReplayEvent[] {
    const predicates = ['project_id = ?'];
    const params: Array<string | number> = [this.projectId];
    if (options.filePath !== undefined) {
      predicates.push('file_path = ?');
      params.push(options.filePath);
    }
    if (options.sessionId !== undefined) {
      predicates.push('session_id = ?');
      params.push(options.sessionId);
    }
    const limit = Math.min(1000, Math.max(1, Math.floor(options.limit ?? 100)));
    const rows = this.db
      .prepare(
        `SELECT id, project_id, session_id, event_type, tool_name, file_path,
                source_hash, graph_hash, policy_version, tool_version,
                outcome, event_hash, created_at
         FROM replay_events
         WHERE ${predicates.join(' AND ')}
         ORDER BY id ASC LIMIT ?`,
      )
      .all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.fromRow(row));
  }

  verify(): { valid: boolean; checkedEvents: number; issues: string[] } {
    // Verification is an integrity operation, not a paginated display query.
    // Do not silently leave events after the public list limit unchecked.
    const events = this.listAll();
    const issues: string[] = [];
    for (const event of events) {
      const input: ReplayEventInput = {
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        eventType: event.eventType,
        toolName: event.toolName,
        ...(event.filePath === undefined ? {} : { filePath: event.filePath }),
        ...(event.sourceHash === undefined ? {} : { sourceHash: event.sourceHash }),
        ...(event.graphHash === undefined ? {} : { graphHash: event.graphHash }),
        ...(event.policyVersion === undefined ? {} : { policyVersion: event.policyVersion }),
        ...(event.toolVersion === undefined ? {} : { toolVersion: event.toolVersion }),
        outcome: event.outcome,
      };
      if (hashEvent(input, this.projectId, event.createdAt) !== event.eventHash) {
        issues.push(`event ${event.id}: event hash mismatch`);
      }
    }
    return { valid: issues.length === 0, checkedEvents: events.length, issues };
  }

  private listAll(): ReplayEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, session_id, event_type, tool_name, file_path,
                source_hash, graph_hash, policy_version, tool_version,
                outcome, event_hash, created_at
         FROM replay_events
         WHERE project_id = ?
         ORDER BY id ASC`,
      )
      .all(this.projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: Record<string, unknown>): ReplayEvent {
    let outcome: Record<string, string | number | boolean | null> = {};
    try {
      const parsed: unknown = JSON.parse(String(row.outcome ?? '{}'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        outcome = parsed as Record<string, string | number | boolean | null>;
      }
    } catch (error) {
      reportSuppressedError(error, 'Intentional fallback src/core/replay/agent-replay.ts:211');
      outcome = { parseError: true };
    }
    return {
      id: Number(row.id),
      projectId: Number(row.project_id),
      sessionId: row.session_id === null ? undefined : Number(row.session_id),
      eventType: String(row.event_type) as ReplayEventType,
      toolName: String(row.tool_name),
      filePath: row.file_path === null ? undefined : String(row.file_path),
      sourceHash: row.source_hash === null ? undefined : String(row.source_hash),
      graphHash: row.graph_hash === null ? undefined : String(row.graph_hash),
      policyVersion: row.policy_version === null ? undefined : String(row.policy_version),
      toolVersion: row.tool_version === null ? undefined : String(row.tool_version),
      outcome,
      eventHash: String(row.event_hash),
      createdAt: String(row.created_at),
    };
  }
}

export function compareReplayEvent(
  event: ReplayEvent,
  current: { sourceHash?: string; graphHash?: string },
): ReplayComparison {
  if (!event.sourceHash && !event.graphHash) {
    return {
      ...event,
      status: 'unavailable',
      reason: 'The event has no source or graph hash to compare.',
    };
  }
  if (event.sourceHash && current.sourceHash !== event.sourceHash) {
    return {
      ...event,
      status: 'diverged',
      reason: 'Current source hash differs from the recorded event.',
    };
  }
  if (event.graphHash && current.graphHash !== event.graphHash) {
    return {
      ...event,
      status: 'diverged',
      reason: 'Current graph hash differs from the recorded event.',
    };
  }
  return { ...event, status: 'recorded' };
}

/** Summarize a canonical replay sequence without storing or exposing payloads. */
export function summarizeReplayTimeline(
  events: readonly (ReplayEvent | ReplayComparison)[],
): ReplayTimelineSummary {
  const ordered = [...events].sort((left, right) => left.id - right.id);
  const sessionIds = new Set(
    ordered
      .map((event) => event.sessionId)
      .filter((sessionId): sessionId is number => sessionId !== undefined),
  );
  const byEventType: Partial<Record<ReplayEventType, number>> = {};
  const byStatus: Partial<Record<ReplayStatus, number>> = {};
  for (const event of ordered) {
    byEventType[event.eventType] = (byEventType[event.eventType] ?? 0) + 1;
    if ('status' in event) byStatus[event.status] = (byStatus[event.status] ?? 0) + 1;
  }
  const firstEventAt = ordered[0]?.createdAt ?? null;
  const lastEventAt = ordered.at(-1)?.createdAt ?? null;
  const firstTime = firstEventAt === null ? Number.NaN : Date.parse(firstEventAt);
  const lastTime = lastEventAt === null ? Number.NaN : Date.parse(lastEventAt);
  return {
    sessionId: sessionIds.size === 1 ? [...sessionIds][0]! : null,
    eventCount: ordered.length,
    firstEventAt,
    lastEventAt,
    durationMs:
      Number.isFinite(firstTime) && Number.isFinite(lastTime)
        ? Math.max(0, lastTime - firstTime)
        : null,
    byEventType,
    byStatus,
  };
}
