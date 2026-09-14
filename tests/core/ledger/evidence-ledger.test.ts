import { afterEach, describe, expect, it } from 'vitest';
import {
  EvidenceLedger,
  computeIndexedGraphHash,
  verifyLedgerExport,
  verifyLedgerRecords,
} from '../../../src/core/ledger/evidence-ledger.js';
import { createTestKnowledgeGraph } from '../../test-helpers/knowledge-graph.js';

describe('EvidenceLedger', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('stores payload-free hash-chained records and verifies them', () => {
    const testGraph = createTestKnowledgeGraph();
    cleanup = testGraph.cleanup;
    const ledger = new EvidenceLedger(testGraph.db, 1);

    const first = ledger.append({
      eventType: 'context',
      toolName: 'get_context',
      input: { filePath: 'src/index.ts', token: 'must-not-be-stored' },
      result: { success: true, content: [{ type: 'text', text: 'secret source' }] },
      graphHash: 'a'.repeat(64),
      summary: { success: true, contentBlocks: 1 },
    });
    const second = ledger.append({
      eventType: 'review',
      toolName: 'review_project',
      input: { base: 'main', head: 'HEAD' },
      result: { success: true, findings: [] },
      policyVersion: '1',
      summary: { success: true, status: 'complete' },
    });

    expect(second.previousHash).toBe(first.recordHash);
    expect(ledger.list()).toHaveLength(2);
    expect(ledger.list()[0]?.inputHash).not.toContain('must-not-be-stored');
    expect(ledger.list()[0]?.summary).toEqual({ contentBlocks: 1, success: true });
    expect(ledger.verify()).toMatchObject({
      valid: true,
      checkedRecords: 2,
      chainHead: second.recordHash,
      issues: [],
    });
  });

  it('composes with an existing SQLite transaction without committing it', () => {
    const testGraph = createTestKnowledgeGraph();
    cleanup = testGraph.cleanup;
    const ledger = new EvidenceLedger(testGraph.db, 1);

    testGraph.db.exec('BEGIN IMMEDIATE');
    ledger.append({ eventType: 'custom', toolName: 'transaction-test', input: {}, result: {} });
    expect(testGraph.db.isTransaction).toBe(true);
    expect(ledger.list()).toHaveLength(1);
    testGraph.db.exec('ROLLBACK');

    expect(testGraph.db.isTransaction).toBe(false);
    expect(ledger.list()).toHaveLength(0);
  });

  it('detects tampering and rejects direct updates/deletes', () => {
    const testGraph = createTestKnowledgeGraph();
    cleanup = testGraph.cleanup;
    const ledger = new EvidenceLedger(testGraph.db, 1);
    const record = ledger.append({
      eventType: 'custom',
      toolName: 'test',
      input: {},
      result: { success: true },
    });

    expect(() =>
      testGraph.db
        .prepare('UPDATE evidence_ledger SET summary = ? WHERE id = ?')
        .run('{}', record.id),
    ).toThrow(/append-only/);
    expect(() =>
      testGraph.db.prepare('DELETE FROM evidence_ledger WHERE id = ?').run(record.id),
    ).toThrow(/append-only/);

    testGraph.db.exec('DROP TRIGGER evidence_ledger_no_update');
    testGraph.db
      .prepare('UPDATE evidence_ledger SET summary = ? WHERE id = ?')
      .run('{"tampered":true}', record.id);
    expect(ledger.verify()).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: 'record-hash-mismatch', id: record.id })],
    });
  });

  it('keeps chains and reads isolated by project', () => {
    const testGraph = createTestKnowledgeGraph();
    cleanup = testGraph.cleanup;
    const second = testGraph.kg.createProject('second', 'C:/second');
    const firstLedger = new EvidenceLedger(testGraph.db, 1);
    const secondLedger = new EvidenceLedger(testGraph.db, second.id);
    firstLedger.append({
      eventType: 'scan',
      toolName: 'scan_project',
      input: {},
      result: { ok: 1 },
    });
    const secondRecord = secondLedger.append({
      eventType: 'scan',
      toolName: 'scan_project',
      input: {},
      result: { ok: 2 },
    });

    expect(secondRecord.previousHash).toBeNull();
    expect(firstLedger.list()).toHaveLength(1);
    expect(secondLedger.list()).toHaveLength(1);
    expect(firstLedger.verify().valid).toBe(true);
    expect(secondLedger.verify().valid).toBe(true);
  });

  it('hashes indexed file identity deterministically', () => {
    const testGraph = createTestKnowledgeGraph();
    cleanup = testGraph.cleanup;
    expect(computeIndexedGraphHash(testGraph.kg)).toBe(computeIndexedGraphHash(testGraph.kg));
    expect(computeIndexedGraphHash(testGraph.kg)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('exports a payload-free bundle that can be verified without the database', () => {
    const testGraph = createTestKnowledgeGraph();
    cleanup = testGraph.cleanup;
    const ledger = new EvidenceLedger(testGraph.db, 1);
    ledger.append({ eventType: 'scan', toolName: 'scan_project', input: {}, result: { files: 2 } });
    ledger.append({
      eventType: 'review',
      toolName: 'review_project',
      input: { base: 'HEAD^' },
      result: { findings: [] },
    });

    const bundle = ledger.exportRecords();
    expect(bundle.format).toBe('projectmind-evidence-ledger-v1');
    expect(bundle).toMatchObject({ totalRecords: 2, complete: true });
    expect(bundle.records[0]).not.toHaveProperty('input');
    expect(verifyLedgerRecords(bundle.projectId, bundle.records)).toMatchObject({
      valid: true,
      checkedRecords: 2,
      chainHead: bundle.records[1]?.recordHash,
      issues: [],
    });
    expect(verifyLedgerExport(bundle).valid).toBe(true);
  });

  it('marks a bounded export incomplete instead of treating it as a backup', () => {
    const testGraph = createTestKnowledgeGraph();
    cleanup = testGraph.cleanup;
    const ledger = new EvidenceLedger(testGraph.db, 1);
    ledger.append({ eventType: 'custom', toolName: 'one', input: {}, result: {} });
    ledger.append({ eventType: 'custom', toolName: 'two', input: {}, result: {} });

    const partial = ledger.exportRecords(1);
    expect(partial.complete).toBe(false);
    expect(verifyLedgerExport(partial)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: 'export-incomplete' })],
    });
  });

  it('rejects reordered, cross-project, and tampered exported records', () => {
    const testGraph = createTestKnowledgeGraph();
    cleanup = testGraph.cleanup;
    const ledger = new EvidenceLedger(testGraph.db, 1);
    ledger.append({ eventType: 'custom', toolName: 'one', input: {}, result: {} });
    ledger.append({ eventType: 'custom', toolName: 'two', input: {}, result: {} });
    const bundle = ledger.exportRecords();
    const reordered = [bundle.records[1]!, bundle.records[0]!];
    const result = verifyLedgerRecords(bundle.projectId, reordered);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['record-order-mismatch', 'previous-hash-mismatch']),
    );

    const crossProject = verifyLedgerRecords(2, bundle.records);
    expect(crossProject.issues[0]?.code).toBe('project-mismatch');

    const tampered = bundle.records.map((record, index) =>
      index === 0 ? { ...record, summary: { tampered: true } } : record,
    );
    expect(verifyLedgerRecords(bundle.projectId, tampered).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'record-hash-mismatch' })]),
    );
  });
});
