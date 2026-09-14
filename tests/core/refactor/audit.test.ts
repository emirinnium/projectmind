import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutoFixEngine } from '@/core/refactor/auto-fix.js';
import { EvidenceLedger } from '@/core/ledger/evidence-ledger.js';
import { AgentReplayStore } from '@/core/replay/agent-replay.js';
import { SCHEMA_SQL } from '@/storage/schema.js';
import { runMigrations } from '@/storage/migrations.js';

describe('edit decision audit', () => {
  it('records preview and applied edit metadata without storing source text', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-edit-audit-'));
    mkdirSync(join(root, 'src'));
    const filePath = join(root, 'src', 'sample.ts');
    const original = 'export function f() {\n  var value = 1;\n  return value;\n}\n';
    writeFileSync(filePath, original, 'utf8');
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);

    const engine = new AutoFixEngine(root, { db, projectId: 3 });
    const preview = engine.run('var-to-const', 'src/sample.ts');
    expect(preview.changed).toBe(true);
    expect(preview.written).toBe(false);
    expect(preview.evidenceAudit).toMatchObject({ ledgerRecordId: 1, replayEventId: 1 });
    expect(readFileSync(filePath, 'utf8')).toBe(original);

    const applied = engine.run('var-to-const', 'src/sample.ts', { write: true });
    expect(applied.written).toBe(true);
    expect(applied.evidenceAudit).toMatchObject({ ledgerRecordId: 2, replayEventId: 2 });
    expect(new EvidenceLedger(db, 3).verify().valid).toBe(true);
    expect(new AgentReplayStore(db, 3).verify().valid).toBe(true);
    const ledgerSummary = db
      .prepare('SELECT summary FROM evidence_ledger ORDER BY id')
      .all() as Array<{ summary: string }>;
    expect(ledgerSummary).toHaveLength(2);
    expect(ledgerSummary[0]?.summary).not.toContain('var value');
    expect(readFileSync(filePath, 'utf8')).toContain('const value');
    db.close();
  });
});
