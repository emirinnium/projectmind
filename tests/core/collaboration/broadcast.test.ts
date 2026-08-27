import { describe, it, expect, beforeEach } from 'vitest';
import { IntentBroadcastService } from '../../../src/core/collaboration/broadcast.js';
import type { IntentBroadcast } from '../../../src/core/collaboration/types.js';

describe('IntentBroadcastService', () => {
  let service: IntentBroadcastService;

  beforeEach(() => {
    service = new IntentBroadcastService();
  });

  it('broadcasts intent and notifies subscribers', () => {
    const received: IntentBroadcast[] = [];
    service.subscribeToIntents('agent-b', (b) => received.push(b));

    const broadcast: IntentBroadcast = {
      agentId: 'agent-a',
      intentType: 'write',
      targetFiles: ['src/core/index.ts'],
      timestamp: Date.now(),
    };

    service.broadcastIntent(broadcast);
    expect(received.length).toBe(1);
    expect(received[0].agentId).toBe('agent-a');
  });

  it('does not notify self', () => {
    const received: IntentBroadcast[] = [];
    service.subscribeToIntents('agent-a', (b) => received.push(b));

    service.broadcastIntent({
      agentId: 'agent-a',
      intentType: 'write',
      targetFiles: ['a.ts'],
      timestamp: Date.now(),
    });

    expect(received.length).toBe(0);
  });

  it('detects conflict when another agent writes to same file', () => {
    service.broadcastIntent({
      agentId: 'agent-a',
      intentType: 'write',
      targetFiles: ['src/core/index.ts'],
      timestamp: Date.now(),
    });

    const result = service.checkConflict('agent-b', ['src/core/index.ts']);
    expect(result.hasConflict).toBe(true);
    expect(result.conflictingAgents).toContain('agent-a');
    expect(result.conflictingFiles).toContain('src/core/index.ts');
    expect(result.riskLevel).toBe('medium');
  });

  it('returns no conflict for read-only intents', () => {
    service.broadcastIntent({
      agentId: 'agent-a',
      intentType: 'read',
      targetFiles: ['src/core/index.ts'],
      timestamp: Date.now(),
    });

    const result = service.checkConflict('agent-b', ['src/core/index.ts']);
    expect(result.hasConflict).toBe(false);
    expect(result.riskLevel).toBe('low');
  });

  it('returns high risk for multiple conflicting agents', () => {
    service.broadcastIntent({ agentId: 'agent-a', intentType: 'write', targetFiles: ['x.ts'], timestamp: Date.now() });
    service.broadcastIntent({ agentId: 'agent-c', intentType: 'refactor', targetFiles: ['x.ts'], timestamp: Date.now() });

    const result = service.checkConflict('agent-b', ['x.ts']);
    expect(result.hasConflict).toBe(true);
    expect(result.riskLevel).toBe('high');
  });

  it('subscription unsubscribe works', () => {
    const received: IntentBroadcast[] = [];
    const unsub = service.subscribeToIntents('agent-x', (b) => received.push(b));
    unsub();

    service.broadcastIntent({ agentId: 'agent-y', intentType: 'delete', targetFiles: ['y.ts'], timestamp: Date.now() });
    expect(received.length).toBe(0);
  });
});
