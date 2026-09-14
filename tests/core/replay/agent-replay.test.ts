import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  AgentReplayStore,
  compareReplayEvent,
  summarizeReplayTimeline,
} from '@/core/replay/agent-replay.js';

describe('agent replay store', () => {
  it('stores payload-free event metadata and verifies it deterministically', () => {
    const db = new DatabaseSync(':memory:');
    const store = new AgentReplayStore(db, 3);
    const event = store.append({
      sessionId: 12,
      eventType: 'context',
      toolName: 'get_context',
      filePath: 'src/auth.ts',
      sourceHash: 'a'.repeat(64),
      graphHash: 'b'.repeat(64),
      policyVersion: 'policy-v1',
      toolVersion: '1.0.4',
      outcome: { selectedFiles: 4, success: true },
    });

    expect(store.list({ filePath: 'src/auth.ts', sessionId: 12 })).toEqual([event]);
    expect(store.verify()).toEqual({ valid: true, checkedEvents: 1, issues: [] });
    expect(event).not.toHaveProperty('payload');
    expect(() =>
      db.prepare('UPDATE replay_events SET tool_name = ? WHERE id = ?').run('x', event.id),
    ).toThrow('replay_events is append-only');
    db.close();
  });

  it('classifies source and graph changes without pretending to replay execution', () => {
    const db = new DatabaseSync(':memory:');
    const store = new AgentReplayStore(db, 1);
    const event = store.append({
      eventType: 'edit',
      toolName: 'auto_fix',
      filePath: 'src/auth.ts',
      sourceHash: 'a'.repeat(64),
      outcome: { applied: false },
    });

    expect(compareReplayEvent(event, { sourceHash: 'b'.repeat(64) }).status).toBe('diverged');
    expect(compareReplayEvent(event, { sourceHash: 'a'.repeat(64) }).status).toBe('recorded');
    expect(
      compareReplayEvent(
        store.append({ eventType: 'scan', toolName: 'scan_project', outcome: { files: 1 } }),
        {},
      ).status,
    ).toBe('unavailable');
    db.close();
  });

  it('normalizes undefined optional fields and verifies beyond the display page size', () => {
    const db = new DatabaseSync(':memory:');
    const store = new AgentReplayStore(db, 5);
    store.append({
      sessionId: undefined,
      eventType: 'decision',
      toolName: 'decision_test',
      filePath: undefined,
      sourceHash: undefined,
      graphHash: undefined,
      policyVersion: undefined,
      toolVersion: undefined,
      outcome: { accepted: true },
    });
    for (let index = 0; index < 1001; index++) {
      store.append({
        eventType: 'context',
        toolName: `context_${index}`,
        outcome: { index },
      });
    }

    expect(store.list({ limit: 1000 })).toHaveLength(1000);
    expect(store.verify()).toEqual({ valid: true, checkedEvents: 1002, issues: [] });
    db.close();
  });

  it('summarizes a session timeline without exposing event payloads', () => {
    const first = {
      id: 2,
      projectId: 1,
      sessionId: 9,
      eventType: 'context' as const,
      toolName: 'get_context',
      outcome: { selectedFiles: 2 },
      createdAt: '2026-09-09T10:00:00.000Z',
      eventHash: 'a'.repeat(64),
    };
    const second = {
      ...first,
      id: 3,
      eventType: 'review' as const,
      toolName: 'review_project',
      status: 'diverged' as const,
      reason: 'source changed',
      createdAt: '2026-09-09T10:00:00.250Z',
      eventHash: 'b'.repeat(64),
    };

    expect(summarizeReplayTimeline([second, first])).toEqual({
      sessionId: 9,
      eventCount: 2,
      firstEventAt: '2026-09-09T10:00:00.000Z',
      lastEventAt: '2026-09-09T10:00:00.250Z',
      durationMs: 250,
      byEventType: { context: 1, review: 1 },
      byStatus: { diverged: 1 },
    });
  });
});
