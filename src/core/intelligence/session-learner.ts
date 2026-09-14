import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { stableHash } from '../../utils/hash.js';

export const SESSION_EVENT_TYPES = ['file_touched', 'tool_used', 'pattern', 'outcome'] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

const eventTypeSchema = z.enum(SESSION_EVENT_TYPES);
const metadataSchema = z.record(
  z.string().max(100),
  z.union([z.string().max(500), z.number().finite(), z.boolean()]),
);

export interface SessionEventInput {
  sessionId: number;
  agentName: string;
  eventType: SessionEventType;
  eventKey: string;
  eventValue?: string;
  success?: boolean;
  metadata?: Record<string, string | number | boolean>;
}

export interface SessionEventReceipt {
  id: number;
  projectId: number;
  sessionId: number;
  eventType: SessionEventType;
  eventKey: string;
}

export interface SessionFileInsight {
  path: string;
  events: number;
  sessions: number;
  lastSeen: string;
}

export interface SessionToolInsight {
  tool: string;
  uses: number;
  sessions: number;
}

export interface SessionOutcomeInsight {
  key: string;
  observations: number;
  successes: number;
  failures: number;
  successRate: number | null;
}

export interface SessionInsights {
  projectId: number;
  agent: string | null;
  eventsScanned: number;
  sessions: number;
  files: SessionFileInsight[];
  tools: SessionToolInsight[];
  outcomes: SessionOutcomeInsight[];
  suggestions: string[];
  limitations: string[];
}

export interface SessionInsightsOptions {
  agentName?: string;
  limit?: number;
  maxEvents?: number;
}

function normalizedAgent(agentName: string): string {
  const value = agentName.trim();
  if (value.length === 0 || value.length > 200) {
    throw new Error('Session agentName must contain 1..200 characters.');
  }
  return value;
}

function normalizedKey(eventType: SessionEventType, eventKey: string): string {
  const value = eventKey.trim().replace(/\\/g, '/');
  if (value.length === 0 || value.length > 500 || value.includes('\0')) {
    throw new Error('Session eventKey must contain 1..500 characters and no NUL bytes.');
  }
  if (
    eventType === 'file_touched' &&
    (value.startsWith('/') || /^[A-Za-z]:\//.test(value) || value.split('/').includes('..'))
  ) {
    throw new Error('file_touched eventKey must be a project-relative path.');
  }
  return value;
}

function agentKey(agentName: string): string {
  return stableHash(agentName).slice(0, 32);
}

function finiteLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Session insight limit must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

/** Append one payload-free event to a project-scoped session history. */
export function recordSessionEvent(
  db: DatabaseSync,
  projectId: number,
  input: SessionEventInput,
): SessionEventReceipt {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error('Session event projectId must be a positive integer.');
  }
  if (!Number.isSafeInteger(input.sessionId) || input.sessionId <= 0) {
    throw new Error('Session event sessionId must be a positive integer.');
  }
  const agentName = normalizedAgent(input.agentName);
  const eventType = eventTypeSchema.parse(input.eventType);
  const eventKey = normalizedKey(eventType, input.eventKey);
  if (input.eventValue !== undefined && input.eventValue.length > 500) {
    throw new Error('Session eventValue must contain at most 500 characters.');
  }
  if (input.success !== undefined && typeof input.success !== 'boolean') {
    throw new Error('Session event success must be boolean when provided.');
  }
  const metadata = metadataSchema.parse(input.metadata ?? {});
  const session = db
    .prepare('SELECT agent_name, project_id FROM agent_sessions WHERE id = ?')
    .get(input.sessionId) as { agent_name?: string; project_id?: number } | undefined;
  if (!session || Number(session.project_id) !== projectId) {
    throw new Error(`Session ${input.sessionId} does not belong to project ${projectId}.`);
  }
  if (session.agent_name !== agentName) {
    throw new Error(`Session ${input.sessionId} belongs to a different agent identity.`);
  }
  const result = db
    .prepare(
      `INSERT INTO agent_session_events
       (project_id, session_id, agent_key, event_type, event_key, event_value, success, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      input.sessionId,
      agentKey(agentName),
      eventType,
      eventKey,
      input.eventValue ?? null,
      input.success === undefined ? null : input.success ? 1 : 0,
      JSON.stringify(metadata),
    );
  return {
    id: Number(result.lastInsertRowid),
    projectId,
    sessionId: input.sessionId,
    eventType,
    eventKey,
  };
}

/**
 * Aggregate recorded events into actionable, evidence-labelled insights.
 * No source content or raw query is read; every suggestion points back to
 * counts of explicit session events.
 */
export function getSessionInsights(
  db: DatabaseSync,
  projectId: number,
  options: SessionInsightsOptions = {},
): SessionInsights {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error('Session insight projectId must be a positive integer.');
  }
  const limit = finiteLimit(options.limit, 10, 100);
  const maxEvents = finiteLimit(options.maxEvents, 10_000, 100_000);
  const agent = options.agentName === undefined ? null : normalizedAgent(options.agentName);
  const key = agent === null ? null : agentKey(agent);
  const rows = (
    key === null
      ? db
          .prepare(
            `SELECT session_id, event_type, event_key, success, created_at
             FROM agent_session_events WHERE project_id = ? ORDER BY id DESC LIMIT ?`,
          )
          .all(projectId, maxEvents)
      : db
          .prepare(
            `SELECT session_id, event_type, event_key, success, created_at
             FROM agent_session_events
             WHERE project_id = ? AND agent_key = ? ORDER BY id DESC LIMIT ?`,
          )
          .all(projectId, key, maxEvents)
  ) as Array<{
    session_id: number;
    event_type: string;
    event_key: string;
    success: number | null;
    created_at: string;
  }>;

  const fileMap = new Map<string, { events: number; sessions: Set<number>; lastSeen: string }>();
  const toolMap = new Map<string, { uses: number; sessions: Set<number> }>();
  const outcomeMap = new Map<
    string,
    { observations: number; successes: number; failures: number }
  >();
  const sessionIds = new Set<number>();
  for (const row of rows) {
    sessionIds.add(row.session_id);
    if (row.event_type === 'file_touched') {
      const current = fileMap.get(row.event_key) ?? {
        events: 0,
        sessions: new Set(),
        lastSeen: row.created_at,
      };
      current.events++;
      current.sessions.add(row.session_id);
      if (row.created_at > current.lastSeen) current.lastSeen = row.created_at;
      fileMap.set(row.event_key, current);
    } else if (row.event_type === 'tool_used') {
      const current = toolMap.get(row.event_key) ?? { uses: 0, sessions: new Set() };
      current.uses++;
      current.sessions.add(row.session_id);
      toolMap.set(row.event_key, current);
    } else if (row.event_type === 'outcome' && row.success !== null) {
      const current = outcomeMap.get(row.event_key) ?? {
        observations: 0,
        successes: 0,
        failures: 0,
      };
      current.observations++;
      if (row.success === 1) current.successes++;
      else current.failures++;
      outcomeMap.set(row.event_key, current);
    }
  }

  const files = [...fileMap.entries()]
    .map(([path, value]) => ({
      path,
      events: value.events,
      sessions: value.sessions.size,
      lastSeen: value.lastSeen,
    }))
    .sort((left, right) => right.events - left.events || left.path.localeCompare(right.path))
    .slice(0, limit);
  const tools = [...toolMap.entries()]
    .map(([tool, value]) => ({ tool, uses: value.uses, sessions: value.sessions.size }))
    .sort((left, right) => right.uses - left.uses || left.tool.localeCompare(right.tool))
    .slice(0, limit);
  const outcomes = [...outcomeMap.entries()]
    .map(([outcomeKey, value]) => ({
      key: outcomeKey,
      ...value,
      successRate:
        value.observations === 0
          ? null
          : Math.round((value.successes / value.observations) * 10_000) / 10_000,
    }))
    .sort((left, right) =>
      left.successRate === null
        ? 1
        : right.successRate === null
          ? -1
          : left.successRate - right.successRate || left.key.localeCompare(right.key),
    )
    .slice(0, limit);

  const suggestions: string[] = [];
  const repeatedFile = files.find((file) => file.sessions >= 3);
  if (repeatedFile) {
    suggestions.push(
      `${repeatedFile.path} appeared in ${repeatedFile.sessions} sessions (${repeatedFile.events} touch events); review its ownership or refactor boundary.`,
    );
  }
  const unstableOutcome = outcomes.find(
    (outcome) =>
      outcome.successRate !== null && outcome.successRate < 0.7 && outcome.observations >= 3,
  );
  if (unstableOutcome) {
    suggestions.push(
      `Outcome "${unstableOutcome.key}" succeeded in ${Math.round((unstableOutcome.successRate ?? 0) * 100)}% of ${unstableOutcome.observations} recorded observations; inspect the associated workflow.`,
    );
  }
  if (suggestions.length === 0 && rows.length > 0) {
    suggestions.push('No repeated or low-success signal crossed the current evidence threshold.');
  }

  return {
    projectId,
    agent,
    eventsScanned: rows.length,
    sessions: sessionIds.size,
    files,
    tools,
    outcomes,
    suggestions,
    limitations: [
      'Insights use only explicitly recorded session events; absence of an event is not evidence that an action did not occur.',
      'No source content, prompt text, or natural-person identity is stored in this learner.',
      ...(rows.length === maxEvents
        ? [`The result is capped at ${maxEvents} events; older events may be omitted.`]
        : []),
    ],
  };
}
