import { describe, expect, it } from 'vitest';
import { createIsolatedDatabase } from '../../test-helpers/database.js';
import {
  getSessionInsights,
  recordSessionEvent,
} from '../../../src/core/intelligence/session-learner.js';

function seedSession(db: import('node:sqlite').DatabaseSync, agentName = 'agent-a'): number {
  const result = db
    .prepare(
      `INSERT INTO agent_sessions (agent_name, project_id, context_hash, decisions, fingerprint)
     VALUES (?, 1, '', '[]', '{}')`,
    )
    .run(agentName);
  return Number(result.lastInsertRowid);
}

describe('session learner', () => {
  it('aggregates only explicit events and produces actionable thresholded insights', () => {
    const isolated = createIsolatedDatabase();
    try {
      const sessionId = seedSession(isolated.db);
      expect(
        recordSessionEvent(isolated.db, 1, {
          sessionId,
          agentName: 'agent-a',
          eventType: 'file_touched',
          eventKey: 'src/auth.ts',
        }),
      ).toMatchObject({ sessionId, eventType: 'file_touched' });
      for (let index = 0; index < 3; index++) {
        recordSessionEvent(isolated.db, 1, {
          sessionId,
          agentName: 'agent-a',
          eventType: 'outcome',
          eventKey: 'scan',
          success: index === 0,
        });
      }
      const insights = getSessionInsights(isolated.db, 1);
      expect(insights.eventsScanned).toBe(4);
      expect(insights.files[0]).toMatchObject({ path: 'src/auth.ts', events: 1 });
      expect(insights.outcomes[0]).toMatchObject({
        key: 'scan',
        observations: 3,
        successes: 1,
        failures: 2,
        successRate: 0.3333,
      });
      expect(insights.suggestions.join(' ')).toMatch(/succeeded in 33%/i);
    } finally {
      isolated.cleanup();
    }
  });

  it('enforces session/project/agent ownership and relative file paths', () => {
    const isolated = createIsolatedDatabase();
    try {
      const sessionId = seedSession(isolated.db, 'agent-a');
      expect(() =>
        recordSessionEvent(isolated.db, 1, {
          sessionId,
          agentName: 'agent-b',
          eventType: 'tool_used',
          eventKey: 'scan',
        }),
      ).toThrow(/different agent/i);
      expect(() =>
        recordSessionEvent(isolated.db, 1, {
          sessionId,
          agentName: 'agent-a',
          eventType: 'file_touched',
          eventKey: '../outside.ts',
        }),
      ).toThrow(/project-relative/i);
    } finally {
      isolated.cleanup();
    }
  });
});
