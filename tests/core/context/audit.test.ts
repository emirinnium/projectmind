import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { EvidenceLedger } from '@/core/ledger/evidence-ledger.js';
import { AgentReplayStore } from '@/core/replay/agent-replay.js';
import { recordContextDecision } from '@/core/context/audit.js';
import { SCHEMA_SQL } from '@/storage/schema.js';
import { runMigrations } from '@/storage/migrations.js';
import type { FileInfo } from '@/storage/kg/types.js';

describe('context decision audit', () => {
  it('records structural context metadata without storing the task text', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    const receipt = recordContextDecision(
      db,
      {
        getCurrentProjectId: () => 11,
        getAllFiles: (): FileInfo[] => [
          {
            id: 1,
            path: 'C:/project/src/context.ts',
            relativePath: 'src/context.ts',
            language: 'typescript',
            sizeBytes: 100,
            hash: 'a'.repeat(64),
            agentTouched: false,
            agentTouchedBy: null,
            agentTouchedAt: null,
            cognitiveLoad: 0,
            lastScanned: '2026-01-01T00:00:00.000Z',
            lastSynced: '2026-01-01T00:00:00.000Z',
            patterns: [],
          },
        ],
      },
      {
        filePath: 'src/context.ts',
        task: 'private task text must not be stored',
        imports: 3,
        resolvedImports: 2,
        dependents: 4,
        similarFiles: 1,
        evidenceStatus: 'verified',
        evidenceFiles: 5,
        selectedPaths: ['src/context.ts'],
        sourceHashes: { 'src/context.ts': 'a'.repeat(64) },
      },
    );

    expect(receipt).toMatchObject({ ledgerRecordId: 1, replayEventId: 1 });
    expect(new EvidenceLedger(db, 11).verify().valid).toBe(true);
    expect(new AgentReplayStore(db, 11).verify().valid).toBe(true);
    expect(db.prepare('SELECT input_hash, summary FROM evidence_ledger').get()).toMatchObject({
      input_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      summary: expect.stringContaining('evidenceStatus'),
    });
    const replay = db.prepare('SELECT outcome FROM replay_events').get() as { outcome: string };
    expect(replay.outcome).toContain('taskProvided');
    expect(replay.outcome).toContain('selectedPaths');
    expect(replay.outcome).not.toContain('private task text');
    db.close();
  });
});
