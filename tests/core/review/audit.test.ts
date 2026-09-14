import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { EvidenceLedger } from '@/core/ledger/evidence-ledger.js';
import { AgentReplayStore } from '@/core/replay/agent-replay.js';
import { recordReviewDecision } from '@/core/review/audit.js';
import { SCHEMA_SQL } from '@/storage/schema.js';
import { runMigrations } from '@/storage/migrations.js';
import type { FileInfo } from '@/storage/kg/types.js';

describe('review decision audit', () => {
  it('records only hashes and scalar review outcome in both chains', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    const kg = {
      getCurrentProjectId: () => 7,
      getAllFiles: (): FileInfo[] => [
        {
          id: 1,
          path: 'C:/project/src/review.ts',
          relativePath: 'src/review.ts',
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
    };
    const receipt = recordReviewDecision(db, kg, {
      base: 'main',
      head: 'HEAD',
      policyVersion: 'policy-v1',
      changedFiles: ['src/review.ts'],
      excludedFiles: 0,
      generatedFindings: 2,
      verifiedFindings: 1,
      complete: true,
      coherenceRisk: 'medium',
    });

    expect(receipt).toMatchObject({
      ledgerRecordId: 1,
      replayEventId: 1,
    });
    expect(new EvidenceLedger(db, 7).verify().valid).toBe(true);
    expect(new AgentReplayStore(db, 7).verify()).toEqual({
      valid: true,
      checkedEvents: 1,
      issues: [],
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM evidence_ledger').get()).toMatchObject({
      count: 1,
    });
    expect(db.prepare('SELECT outcome FROM replay_events').get()).toMatchObject({
      outcome: expect.stringContaining('verifiedFindings'),
    });
    expect(db.prepare('SELECT outcome FROM replay_events').get()).not.toMatchObject({
      outcome: expect.stringContaining('src/review.ts'),
    });
    db.close();
  });

  it('is a no-op when no database is available', () => {
    expect(
      recordReviewDecision(
        undefined,
        { getCurrentProjectId: () => 1, getAllFiles: () => [] },
        {
          base: 'main',
          head: 'HEAD',
          policyVersion: 'policy-v1',
          changedFiles: [],
          excludedFiles: 0,
          generatedFindings: 0,
          verifiedFindings: 0,
          complete: true,
        },
      ),
    ).toBeUndefined();
  });
});
