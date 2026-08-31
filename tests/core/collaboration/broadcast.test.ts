import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntentBroadcastService } from '../../../src/core/collaboration/broadcast.js';
import { SCHEMA_SQL } from '../../../src/storage/schema.js';
import type { IntentBroadcast } from '../../../src/core/collaboration/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('IntentBroadcastService', () => {
  let tmpDir: string;
  let db: DatabaseSync;
  let service: IntentBroadcastService;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pm-broadcast-'));
    db = new DatabaseSync(join(tmpDir, 'broadcast-test.db'));
    db.exec(SCHEMA_SQL);
  });

  afterAll(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.exec('DELETE FROM pending_intents');
    // Public branch by default so intents persist into the temp DB.
    service = new IntentBroadcastService(db, { branchDetector: () => 'main' });
  });

  it('broadcasts intent and notifies subscribers', () => {
    const received: IntentBroadcast[] = [];
    service.subscribeToIntents('agent-b', (b) => received.push(b));

    service.broadcastIntent({
      agentId: 'agent-a',
      intentType: 'write',
      targetFiles: ['src/core/index.ts'],
      timestamp: Date.now(),
    });

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

  // (a) broadcast -> checkConflict detects overlapping write intent with reason
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
    expect(result.reasons.some((r) => r.includes('agent-a'))).toBe(true);
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

  // (b) TTL enforcement: expired intents ignored by checkConflict, removed by
  // expireIntents while unexpired intents survive (F19).
  it('ignores expired intents in checkConflict and expireIntents removes only expired', async () => {
    service.broadcastIntent({
      agentId: 'agent-a',
      intentType: 'write',
      targetFiles: ['short-lived.ts'],
      timestamp: Date.now(),
      ttlSeconds: 0.05, // 50ms
    });
    service.broadcastIntent({
      agentId: 'agent-a',
      intentType: 'write',
      targetFiles: ['long-lived.ts'],
      timestamp: Date.now(),
      ttlSeconds: 300,
    });

    await sleep(80);

    // Expired intent no longer conflicts; unexpired one still does.
    const afterExpiry = service.checkConflict('agent-b', ['short-lived.ts']);
    expect(afterExpiry.hasConflict).toBe(false);
    const stillActive = service.checkConflict('agent-b', ['long-lived.ts']);
    expect(stillActive.hasConflict).toBe(true);

    service.expireIntents();

    // Expired DB row removed, unexpired row survives.
    const rows = db.prepare('SELECT target_files FROM pending_intents').all() as Array<{ target_files: string }>;
    const allFiles = rows.flatMap((r) => JSON.parse(r.target_files) as string[]);
    expect(allFiles).not.toContain('short-lived.ts');
    expect(allFiles).toContain('long-lived.ts');

    // In-memory: unexpired intent still detected after expireIntents.
    const still = service.checkConflict('agent-b', ['long-lived.ts']);
    expect(still.hasConflict).toBe(true);
  });

  // (c) private-branch sanitization (F45/F18)
  it('does not persist intents from private branches and marks scope local', () => {
    const privateService = new IntentBroadcastService(db, { branchDetector: () => 'private/foo' });
    const stamped = privateService.broadcastIntent({
      agentId: 'agent-a',
      intentType: 'write',
      targetFiles: ['secret-work.ts'],
      timestamp: Date.now(),
    });

    expect(stamped.scope).toBe('local');
    const rows = db.prepare('SELECT COUNT(*) AS n FROM pending_intents').get() as { n: number };
    expect(rows.n).toBe(0);

    // Still visible in-memory to this instance (local scope).
    const conflict = privateService.checkConflict('agent-b', ['secret-work.ts']);
    expect(conflict.hasConflict).toBe(true);
  });

  it('persists intents from public branches with shared scope', () => {
    const stamped = service.broadcastIntent({
      agentId: 'agent-a',
      intentType: 'write',
      targetFiles: ['public-work.ts'],
      timestamp: Date.now(),
    });

    expect(stamped.scope).toBe('shared');
    const rows = db.prepare('SELECT target_files FROM pending_intents').all() as Array<{ target_files: string }>;
    expect(rows.flatMap((r) => JSON.parse(r.target_files) as string[])).toContain('public-work.ts');
  });

  it('treats undetectable branch as the configurable public-safe default', () => {
    const noGit = new IntentBroadcastService(db, {
      branchDetector: () => {
        throw new Error('git unavailable');
      },
      fallbackBranch: 'develop',
    });
    const stamped = noGit.broadcastIntent({
      agentId: 'agent-a',
      intentType: 'write',
      targetFiles: ['fallback.ts'],
      timestamp: Date.now(),
    });
    expect(stamped.scope).toBe('shared');
  });

  it('supports custom private-branch patterns', () => {
    const custom = new IntentBroadcastService(db, {
      branchDetector: () => 'classified/x',
      privateBranchPatterns: [/^classified\//i],
    });
    const stamped = custom.broadcastIntent({
      agentId: 'agent-a',
      intentType: 'write',
      targetFiles: ['custom.ts'],
      timestamp: Date.now(),
    });
    expect(stamped.scope).toBe('local');
  });

  // (d) expectedChanges round-trips through DB as JSON (F17)
  it('round-trips expectedChanges through the database as JSON', () => {
    const expectedChanges = {
      signatureChanges: [{ function: 'optimize', oldSig: 'optimize(items)', newSig: 'optimize(items, budget)' }],
      typeChanges: [{ type: 'Plan', oldDef: '{ total: number }', newDef: '{ total: number; files: string[] }' }],
      notes: ['adds budget parameter'],
    };

    service.broadcastIntent({
      agentId: 'agent-a',
      intentType: 'refactor',
      targetFiles: ['src/opt.ts'],
      timestamp: Date.now(),
      expectedChanges,
    });

    // A fresh service instance on the same DB sees it via subscribe.
    const other = new IntentBroadcastService(db, { branchDetector: () => 'main' });
    const received: IntentBroadcast[] = [];
    other.subscribeToIntents('agent-b', (b) => received.push(b));

    expect(received.length).toBe(1);
    expect(received[0].expectedChanges).toEqual(expectedChanges);
  });

  // (e) subscribe loads OTHER agents' intents, dedupes on double subscribe (F21)
  it('subscribe loads other agents` intents only and dedupes on double subscribe', () => {
    service.broadcastIntent({ agentId: 'agent-a', intentType: 'write', targetFiles: ['shared.ts'], timestamp: Date.now() });
    service.broadcastIntent({ agentId: 'agent-b', intentType: 'write', targetFiles: ['own.ts'], timestamp: Date.now() });

    const other = new IntentBroadcastService(db, { branchDetector: () => 'main' });
    const received: IntentBroadcast[] = [];
    other.subscribeToIntents('agent-b', (b) => received.push(b));

    // Loads agent-a's intent, never agent-b's own.
    expect(received.map((b) => b.agentId)).toEqual(['agent-a']);

    // Double subscribe must not duplicate in-memory entries.
    other.subscribeToIntents('agent-b', (b) => received.push(b));
    expect(received.length).toBe(1);

    const conflict = other.checkConflict('agent-b', ['shared.ts']);
    expect(conflict.hasConflict).toBe(true);
    expect(conflict.conflictingAgents.filter((a) => a === 'agent-a')).toHaveLength(1);
  });

  // (f) caller object is never mutated (F22)
  it('does not mutate the caller object', () => {
    const original: IntentBroadcast = {
      agentId: 'agent-a',
      intentType: 'write',
      targetFiles: ['a.ts', 'b.ts'],
      timestamp: 0, // falsy on purpose: service stamps it on the clone
    };
    const snapshot = JSON.parse(JSON.stringify(original)) as IntentBroadcast;

    const stamped = service.broadcastIntent(original);

    expect(original).toEqual(snapshot);
    expect(original.id).toBeUndefined();
    expect(original.ttlSeconds).toBeUndefined();
    expect(original.scope).toBeUndefined();
    expect(original.timestamp).toBe(0);
    expect(stamped).not.toBe(original);
    expect(stamped.id).toBeDefined();
    expect(stamped.timestamp).toBeGreaterThan(0);
    expect(stamped.ttlSeconds).toBe(300);
  });

  it('stores broadcast_at and expires_at as integer unix milliseconds (F20)', () => {
    const before = Date.now();
    service.broadcastIntent({
      agentId: 'agent-a',
      intentType: 'write',
      targetFiles: ['ints.ts'],
      timestamp: Date.now(),
      ttlSeconds: 120,
    });

    const row = db.prepare('SELECT broadcast_at, expires_at FROM pending_intents').get() as {
      broadcast_at: number | string;
      expires_at: number | string;
    };
    expect(typeof row.broadcast_at).toBe('number');
    expect(typeof row.expires_at).toBe('number');
    expect(row.broadcast_at).toBeGreaterThanOrEqual(before);
    expect(row.expires_at).toBeGreaterThanOrEqual((row.broadcast_at as number) + 119_000);
    expect(row.expires_at).toBeLessThanOrEqual((row.broadcast_at as number) + 121_000);
  });

  // getActiveIntents (F38b): per-intent view for conflict warnings.
  it('getActiveIntents merges memory + DB without duplicating the same intent', () => {
    service.broadcastIntent({
      agentId: 'agent-a',
      intentType: 'write',
      targetFiles: ['dup.ts'],
      timestamp: Date.now(),
    });

    // The intent now exists BOTH in memory (UUID id) and in the DB (row id) —
    // content-based dedup must collapse them into a single entry.
    const active = service.getActiveIntents('agent-b');
    expect(active).toHaveLength(1);
    expect(active[0].agentId).toBe('agent-a');
    expect(active[0].targetFiles).toEqual(['dup.ts']);
  });

  it('getActiveIntents excludes the requesting agent and expired intents', async () => {
    service.broadcastIntent({
      agentId: 'agent-a',
      intentType: 'write',
      targetFiles: ['mine.ts'],
      timestamp: Date.now(),
    });
    service.broadcastIntent({
      agentId: 'agent-b',
      intentType: 'refactor',
      targetFiles: ['gone.ts'],
      timestamp: Date.now(),
      ttlSeconds: 0.05,
    });

    await sleep(80);

    const forAgentB = service.getActiveIntents('agent-b');
    expect(forAgentB.map((b) => b.agentId)).toEqual(['agent-a']);

    const forAgentA = service.getActiveIntents('agent-a');
    // agent-b's intent expired — nothing left for agent-a to see.
    expect(forAgentA).toHaveLength(0);
  });

  // Poisoned target_files rows: VALID JSON that is not a string[]
  // ('42', 'null', '{}', '"str"') passes JSON.parse and used to throw on
  // .includes/spread — blinding conflict detection for every later row and
  // even escaping checkConflict uncaught via the in-memory loop.
  describe('poisoned target_files rows (valid JSON, not string[])', () => {
    const POISONS = ['42', 'null', '{}', '"str"'];

    function insertPoisonRows(): void {
      const now = Date.now();
      POISONS.forEach((payload, i) => {
        db.prepare(
          `INSERT INTO pending_intents (agent_id, intent_type, target_files, broadcast_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(`poison-${i}`, 'write', payload, now, now + 300_000);
      });
    }

    function insertGenuineRow(agentId: string, file: string): void {
      const now = Date.now();
      db.prepare(
        `INSERT INTO pending_intents (agent_id, intent_type, target_files, broadcast_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(agentId, 'write', JSON.stringify([file]), now, now + 300_000);
    }

    it('checkConflict skips poison rows and still detects the genuine conflict', () => {
      insertPoisonRows();
      insertGenuineRow('agent-real', 'src/real.ts');

      // Fresh service: no in-memory state, everything comes from the DB.
      const fresh = new IntentBroadcastService(db, { branchDetector: () => 'main' });
      const result = fresh.checkConflict('agent-b', ['src/real.ts']);

      expect(result.hasConflict).toBe(true);
      expect(result.conflictingAgents).toContain('agent-real');
      expect(result.conflictingFiles).toContain('src/real.ts');
    });

    it('getActiveIntents returns genuine rows after poison rows', () => {
      insertPoisonRows();
      insertGenuineRow('agent-real', 'src/real.ts');

      const fresh = new IntentBroadcastService(db, { branchDetector: () => 'main' });
      const active = fresh.getActiveIntents('agent-b');

      // Poison rows never surface; the genuine row survives.
      expect(active.some((b) => b.agentId === 'agent-real')).toBe(true);
      expect(active.every((b) => !b.agentId.startsWith('poison-'))).toBe(true);
      expect(
        active.every((b) => Array.isArray(b.targetFiles) && b.targetFiles.every((f) => typeof f === 'string'))
      ).toBe(true);
    });

    it('subscribeToIntents skips poison rows, loads the genuine intent, and conflict still fires', () => {
      insertPoisonRows();
      insertGenuineRow('agent-real', 'src/real.ts');

      const fresh = new IntentBroadcastService(db, { branchDetector: () => 'main' });
      const received: IntentBroadcast[] = [];
      fresh.subscribeToIntents('agent-b', (b) => received.push(b));

      expect(received.map((b) => b.agentId)).toEqual(['agent-real']);
      expect(received[0].targetFiles).toEqual(['src/real.ts']);

      // The genuine intent now lives in memory AND in the DB — conflict
      // detection must work and must not throw.
      const result = fresh.checkConflict('agent-b', ['src/real.ts']);
      expect(result.hasConflict).toBe(true);
      expect(result.conflictingAgents).toContain('agent-real');
    });

    it('checkConflict never throws with poisoned in-memory entries (ingestion sanitized)', () => {
      // Runtime callers may hand us non-array targetFiles despite the type
      // signature — ingestion must sanitize so activeIntents stays clean.
      const bogus: IntentBroadcast = {
        agentId: 'agent-a',
        intentType: 'write',
        targetFiles: 42 as unknown as string[],
        timestamp: Date.now(),
      };
      expect(() => service.broadcastIntent(bogus)).not.toThrow();

      const nullish: IntentBroadcast = {
        agentId: 'agent-a',
        intentType: 'refactor',
        targetFiles: null as unknown as string[],
        timestamp: Date.now(),
      };
      expect(() => service.broadcastIntent(nullish)).not.toThrow();

      // No throw, no phantom conflicts, and nothing malformed in memory.
      expect(() => service.checkConflict('agent-b', ['x.ts'])).not.toThrow();
      const result = service.checkConflict('agent-b', ['x.ts']);
      expect(result.hasConflict).toBe(false);
      const active = service.getActiveIntents('agent-b');
      expect(active.every((b) => Array.isArray(b.targetFiles))).toBe(true);
    });

    it('non-object expected_changes payloads are discarded, intent kept', () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO pending_intents (agent_id, intent_type, target_files, expected_changes, broadcast_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('agent-ec', 'write', '["src/ec.ts"]', '"just-a-string"', now, now + 300_000);

      const fresh = new IntentBroadcastService(db, { branchDetector: () => 'main' });
      const active = fresh.getActiveIntents('agent-b');
      const intent = active.find((b) => b.agentId === 'agent-ec');
      expect(intent).toBeDefined();
      expect(intent?.expectedChanges).toBeUndefined();
      expect(intent?.targetFiles).toEqual(['src/ec.ts']);
    });
  });
});
