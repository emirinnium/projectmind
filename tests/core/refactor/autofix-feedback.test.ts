import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { AutoFixFeedbackStore } from '@/core/refactor/autofix-feedback.js';

describe('AutoFixFeedbackStore', () => {
  it('keeps recommendations project and agent scoped', () => {
    const db = new DatabaseSync(':memory:');
    const first = new AutoFixFeedbackStore(db, 1);
    const second = new AutoFixFeedbackStore(db, 2);

    for (let index = 0; index < 3; index += 1) {
      first.record({ fixer: 'var-to-const', feedback: 'accepted', agentName: 'agent-a' });
    }
    first.record({ fixer: 'var-to-const', feedback: 'rejected', agentName: 'agent-b' });
    second.record({ fixer: 'var-to-const', feedback: 'rejected', agentName: 'agent-a' });

    expect(first.recommend(['var-to-const'], { agentName: 'agent-a' })[0]).toMatchObject({
      status: 'recommend',
      accepted: 3,
      rejected: 0,
      decidedSamples: 3,
      acceptanceRate: 1,
    });
    expect(first.recommend(['var-to-const'], { agentName: 'agent-b' })[0]).toMatchObject({
      status: 'insufficient-evidence',
      accepted: 0,
      rejected: 1,
    });
    expect(second.recommend(['var-to-const'], { agentName: 'agent-a' })[0]).toMatchObject({
      status: 'insufficient-evidence',
      accepted: 0,
      rejected: 1,
    });
    db.close();
  });

  it('treats skipped outcomes as context, not acceptance evidence', () => {
    const db = new DatabaseSync(':memory:');
    const store = new AutoFixFeedbackStore(db, 1);
    store.record({ fixer: 'organize-imports', feedback: 'skipped' });
    store.record({ fixer: 'organize-imports', feedback: 'skipped' });

    expect(store.recommend(['organize-imports'])[0]).toMatchObject({
      skipped: 2,
      decidedSamples: 0,
      acceptanceRate: null,
      interval: null,
      status: 'insufficient-evidence',
    });
    db.close();
  });

  it('does not allow historical feedback to be edited or deleted', () => {
    const db = new DatabaseSync(':memory:');
    const store = new AutoFixFeedbackStore(db, 1);
    const record = store.record({ fixer: 'dedupe-imports', feedback: 'rejected' });

    expect(() =>
      db
        .prepare('UPDATE autofix_feedback SET feedback = ? WHERE id = ?')
        .run('accepted', record.id),
    ).toThrow('autofix_feedback is append-only');
    expect(() => db.prepare('DELETE FROM autofix_feedback WHERE id = ?').run(record.id)).toThrow(
      'autofix_feedback is append-only',
    );
    db.close();
  });

  it('supports opt-out and a logical reset without deleting audit history', () => {
    const db = new DatabaseSync(':memory:');
    const store = new AutoFixFeedbackStore(db, 1);
    store.record({ fixer: 'var-to-const', feedback: 'accepted', agentName: 'agent-a' });
    store.setOptOut('agent-a', true);
    expect(store.isOptedOut('agent-a')).toBe(true);
    expect(() =>
      store.record({ fixer: 'var-to-const', feedback: 'accepted', agentName: 'agent-a' }),
    ).toThrow('opted out');
    expect(store.recommend(['var-to-const'], { agentName: 'agent-a' })[0]?.status).toBe(
      'opted-out',
    );

    store.setOptOut('agent-a', false);
    const reset = store.reset('agent-a');
    expect(reset.resetId).toBe(1);
    expect(store.recommend(['var-to-const'], { agentName: 'agent-a' })[0]).toMatchObject({
      status: 'insufficient-evidence',
      decidedSamples: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM autofix_feedback').get()).toMatchObject({
      count: 1,
    });
    db.close();
  });

  it('uses the feedback-table boundary rather than the reset-table id', () => {
    const db = new DatabaseSync(':memory:');
    const store = new AutoFixFeedbackStore(db, 1);
    store.record({ fixer: 'var-to-const', feedback: 'accepted', agentName: 'agent-a' });
    store.record({ fixer: 'organize-imports', feedback: 'accepted', agentName: 'agent-b' });
    const reset = store.reset('agent-a');
    expect(reset.feedbackBoundary).toBe(1);
    store.record({ fixer: 'var-to-const', feedback: 'rejected', agentName: 'agent-a' });

    expect(store.recommend(['var-to-const'], { agentName: 'agent-a' })[0]).toMatchObject({
      accepted: 0,
      rejected: 1,
      decidedSamples: 1,
    });
    db.close();
  });
});
