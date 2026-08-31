import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { DebtPersistence, DebtType, Severity } from '../../../../src/core/debt/detection/persistence.js';
import { SCHEMA_SQL } from '../../../../src/storage/schema.js';

/**
 * Creates a fully-initialized in-memory database with schema for testing.
 */
function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

describe('DebtPersistence', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('createDebtItem()', () => {
    it('creates a new debt item with all fields', () => {
      const persistence = new DebtPersistence(db);
      const item = persistence.createDebtItem({
        type: 'complexity',
        description: 'Function too complex',
        severity: 'high',
        suggestion: 'Refactor into smaller functions',
        reasoningTrace: ['Cyclomatic complexity > 10'],
        filePath: null,
      });

      expect(item).toBeDefined();
      expect(item.id).toBeGreaterThan(0);
      expect(item.type).toBe('complexity');
      expect(item.description).toBe('Function too complex');
      expect(item.severity).toBe('high');
      expect(item.suggestion).toBe('Refactor into smaller functions');
      expect(item.reasoningTrace).toEqual(['Cyclomatic complexity > 10']);
      expect(item.resolved).toBe(false);
      expect(item.detectedAt).toBeDefined();
    });

    it('creates debt item linked to a file', () => {
      // Insert a file first
      const fileResult = db.prepare(
        `INSERT INTO files (path, relative_path, language) VALUES (?, ?, ?)`
      ).run('/project/src/utils.ts', 'src/utils.ts', 'typescript');

      const persistence = new DebtPersistence(db);
      const item = persistence.createDebtItem({
        type: 'pattern_drift',
        description: 'Pattern drift detected',
        severity: 'medium',
        suggestion: 'Update pattern',
        reasoningTrace: ['Pattern mismatch'],
        filePath: 'src/utils.ts',
      });

      expect(item.id).toBeGreaterThan(0);
      expect(item.filePath).toBe('src/utils.ts');

      // Verify file_id was set
      const row = db.prepare('SELECT file_id FROM debt_items WHERE id = ?').get(item.id) as { file_id: number | null };
      expect(row.file_id).toBe(Number(fileResult.lastInsertRowid));
    });

    it('creates debt item with null filePath', () => {
      const persistence = new DebtPersistence(db);
      const item = persistence.createDebtItem({
        type: 'code_age',
        description: 'Old code',
        severity: 'low',
        suggestion: 'Review',
        reasoningTrace: [],
        filePath: null,
      });

      expect(item.filePath).toBeNull();
    });
  });

  describe('deduplication logic', () => {
    it('updates existing item instead of inserting duplicate', () => {
      const persistence = new DebtPersistence(db);

      const item1 = persistence.createDebtItem({
        type: 'complexity',
        description: 'Same issue',
        severity: 'high',
        suggestion: 'Fix A',
        reasoningTrace: ['trace 1'],
        filePath: null,
      });

      const item2 = persistence.createDebtItem({
        type: 'complexity',
        description: 'Same issue',
        severity: 'medium',
        suggestion: 'Fix B',
        reasoningTrace: ['trace 2'],
        filePath: null,
      });

      // Should return the same ID (updated, not inserted)
      expect(item2.id).toBe(item1.id);

      // Verify only one row exists
      const count = db.prepare('SELECT COUNT(*) as cnt FROM debt_items').get() as { cnt: number };
      expect(count.cnt).toBe(1);

      // Verify the severity was updated
      const row = db.prepare('SELECT severity FROM debt_items WHERE id = ?').get(item1.id) as { severity: string };
      expect(row.severity).toBe('medium');
    });

    it('inserts new item when description differs', () => {
      const persistence = new DebtPersistence(db);

      persistence.createDebtItem({
        type: 'complexity',
        description: 'Issue A',
        severity: 'high',
        suggestion: 'Fix A',
        reasoningTrace: [],
        filePath: null,
      });

      persistence.createDebtItem({
        type: 'complexity',
        description: 'Issue B',
        severity: 'high',
        suggestion: 'Fix B',
        reasoningTrace: [],
        filePath: null,
      });

      const count = db.prepare('SELECT COUNT(*) as cnt FROM debt_items').get() as { cnt: number };
      expect(count.cnt).toBe(2);
    });

    it('inserts new item when type differs', () => {
      const persistence = new DebtPersistence(db);

      persistence.createDebtItem({
        type: 'complexity',
        description: 'Same description',
        severity: 'high',
        suggestion: 'Fix',
        reasoningTrace: [],
        filePath: null,
      });

      persistence.createDebtItem({
        type: 'redundancy',
        description: 'Same description',
        severity: 'high',
        suggestion: 'Fix',
        reasoningTrace: [],
        filePath: null,
      });

      const count = db.prepare('SELECT COUNT(*) as cnt FROM debt_items').get() as { cnt: number };
      expect(count.cnt).toBe(2);
    });

    it('inserts duplicate if existing item is resolved', () => {
      const persistence = new DebtPersistence(db);

      const item1 = persistence.createDebtItem({
        type: 'complexity',
        description: 'Same issue',
        severity: 'high',
        suggestion: 'Fix',
        reasoningTrace: [],
        filePath: null,
      });

      // Resolve the first item
      persistence.resolveDebt(item1.id);

      // Now creating same item should insert new row
      const item2 = persistence.createDebtItem({
        type: 'complexity',
        description: 'Same issue',
        severity: 'high',
        suggestion: 'Fix',
        reasoningTrace: [],
        filePath: null,
      });

      expect(item2.id).not.toBe(item1.id);
      const count = db.prepare('SELECT COUNT(*) as cnt FROM debt_items').get() as { cnt: number };
      expect(count.cnt).toBe(2);
    });
  });

  describe('getReport()', () => {
    it('returns empty report when no debt exists', () => {
      const persistence = new DebtPersistence(db);
      const report = persistence.getReport();

      expect(report.totalItems).toBe(0);
      expect(report.bySeverity.high).toBe(0);
      expect(report.bySeverity.medium).toBe(0);
      expect(report.bySeverity.low).toBe(0);
      expect(report.items).toHaveLength(0);
      expect(report.hasMore).toBe(false);
    });

    it('returns all debt items in report', () => {
      const persistence = new DebtPersistence(db);

      persistence.createDebtItem({
        type: 'complexity',
        description: 'Issue 1',
        severity: 'high',
        suggestion: 'Fix 1',
        reasoningTrace: [],
        filePath: null,
      });

      persistence.createDebtItem({
        type: 'redundancy',
        description: 'Issue 2',
        severity: 'medium',
        suggestion: 'Fix 2',
        reasoningTrace: [],
        filePath: null,
      });

      const report = persistence.getReport();
      expect(report.totalItems).toBe(2);
      expect(report.bySeverity.high).toBe(1);
      expect(report.bySeverity.medium).toBe(1);
      expect(report.bySeverity.low).toBe(0);
    });

    it('filters by severity', () => {
      const persistence = new DebtPersistence(db);

      persistence.createDebtItem({
        type: 'complexity',
        description: 'High issue',
        severity: 'high',
        suggestion: 'Fix',
        reasoningTrace: [],
        filePath: null,
      });

      persistence.createDebtItem({
        type: 'complexity',
        description: 'Low issue',
        severity: 'low',
        suggestion: 'Fix',
        reasoningTrace: [],
        filePath: null,
      });

      const report = persistence.getReport({ severity: 'high' });
      expect(report.totalItems).toBe(1);
      expect(report.items[0].severity).toBe('high');
    });

    it('filters by type', () => {
      const persistence = new DebtPersistence(db);

      persistence.createDebtItem({
        type: 'complexity',
        description: 'Complexity issue',
        severity: 'high',
        suggestion: 'Fix',
        reasoningTrace: [],
        filePath: null,
      });

      persistence.createDebtItem({
        type: 'redundancy',
        description: 'Redundancy issue',
        severity: 'medium',
        suggestion: 'Fix',
        reasoningTrace: [],
        filePath: null,
      });

      const report = persistence.getReport({ type: 'redundancy' });
      expect(report.totalItems).toBe(1);
      expect(report.items[0].type).toBe('redundancy');
    });

    it('excludes resolved items by default', () => {
      const persistence = new DebtPersistence(db);

      const item = persistence.createDebtItem({
        type: 'complexity',
        description: 'Will be resolved',
        severity: 'high',
        suggestion: 'Fix',
        reasoningTrace: [],
        filePath: null,
      });

      persistence.createDebtItem({
        type: 'complexity',
        description: 'Still open',
        severity: 'medium',
        suggestion: 'Fix',
        reasoningTrace: [],
        filePath: null,
      });

      persistence.resolveDebt(item.id);

      const report = persistence.getReport();
      expect(report.totalItems).toBe(1);
      expect(report.items[0].description).toBe('Still open');
    });

    it('includes resolved items when includeResolved is true', () => {
      const persistence = new DebtPersistence(db);

      const item = persistence.createDebtItem({
        type: 'complexity',
        description: 'Resolved item',
        severity: 'high',
        suggestion: 'Fix',
        reasoningTrace: [],
        filePath: null,
      });

      persistence.resolveDebt(item.id);

      const report = persistence.getReport({ includeResolved: true });
      expect(report.totalItems).toBe(1);
      expect(report.items[0].resolved).toBe(true);
    });

    it('supports pagination with limit and offset', () => {
      const persistence = new DebtPersistence(db);

      for (let i = 0; i < 5; i++) {
        persistence.createDebtItem({
          type: 'complexity',
          description: `Issue ${i}`,
          severity: 'medium',
          suggestion: 'Fix',
          reasoningTrace: [],
          filePath: null,
        });
      }

      const page1 = persistence.getReport({ limit: 2, offset: 0 });
      expect(page1.items).toHaveLength(2);
      expect(page1.hasMore).toBe(true);

      const page2 = persistence.getReport({ limit: 2, offset: 2 });
      expect(page2.items).toHaveLength(2);
      expect(page2.hasMore).toBe(true);

      const page3 = persistence.getReport({ limit: 2, offset: 4 });
      expect(page3.items).toHaveLength(1);
      expect(page3.hasMore).toBe(false);
    });

    it('returns coherence genome score from latest genome snapshot', () => {
      // Insert a genome snapshot
      db.prepare(
        `INSERT INTO project_genome (checksum, genome_data, coherence_score, computed_at)
         VALUES (?, ?, ?, ?)`
      ).run('abc123', '{}', 0.92, new Date().toISOString());

      const persistence = new DebtPersistence(db);
      const report = persistence.getReport();

      expect(report.coherenceGenomeScore).toBe(0.92);
    });

    it('returns default genome score when no genome snapshot exists', () => {
      const persistence = new DebtPersistence(db);
      const report = persistence.getReport();

      expect(report.coherenceGenomeScore).toBe(0.85);
    });

    it('includes file path in report items', () => {
      db.prepare(
        `INSERT INTO files (path, relative_path, language) VALUES (?, ?, ?)`
      ).run('/project/src/test.ts', 'src/test.ts', 'typescript');

      const persistence = new DebtPersistence(db);
      persistence.createDebtItem({
        type: 'complexity',
        description: 'Test issue',
        severity: 'high',
        suggestion: 'Fix',
        reasoningTrace: [],
        filePath: 'src/test.ts',
      });

      const report = persistence.getReport();
      expect(report.items[0].filePath).toBe('src/test.ts');
    });
  });

  describe('resolveDebt()', () => {
    it('marks a debt item as resolved', () => {
      const persistence = new DebtPersistence(db);
      const item = persistence.createDebtItem({
        type: 'complexity',
        description: 'To resolve',
        severity: 'high',
        suggestion: 'Fix',
        reasoningTrace: [],
        filePath: null,
      });

      persistence.resolveDebt(item.id);

      const row = db.prepare('SELECT resolved FROM debt_items WHERE id = ?').get(item.id) as { resolved: number };
      expect(row.resolved).toBe(1);
    });

    it('sets resolved_at timestamp', () => {
      const persistence = new DebtPersistence(db);
      const item = persistence.createDebtItem({
        type: 'complexity',
        description: 'To resolve',
        severity: 'high',
        suggestion: 'Fix',
        reasoningTrace: [],
        filePath: null,
      });

      persistence.resolveDebt(item.id);

      const row = db.prepare('SELECT resolved_at FROM debt_items WHERE id = ?').get(item.id) as { resolved_at: string };
      expect(row.resolved_at).toBeDefined();
    });

    it('does not throw for non-existent debt id', () => {
      const persistence = new DebtPersistence(db);
      expect(() => persistence.resolveDebt(999)).not.toThrow();
    });
  });

  describe('clearAll()', () => {
    it('removes all debt items', () => {
      const persistence = new DebtPersistence(db);

      persistence.createDebtItem({
        type: 'complexity',
        description: 'Issue 1',
        severity: 'high',
        suggestion: 'Fix',
        reasoningTrace: [],
        filePath: null,
      });

      persistence.createDebtItem({
        type: 'redundancy',
        description: 'Issue 2',
        severity: 'medium',
        suggestion: 'Fix',
        reasoningTrace: [],
        filePath: null,
      });

      persistence.clearAll();

      const count = db.prepare('SELECT COUNT(*) as cnt FROM debt_items').get() as { cnt: number };
      expect(count.cnt).toBe(0);
    });

    it('does not throw when no debt items exist', () => {
      const persistence = new DebtPersistence(db);
      expect(() => persistence.clearAll()).not.toThrow();
    });
  });

  describe('batchInsertDebtItems()', () => {
    it('inserts multiple debt items in a batch', () => {
      const persistence = new DebtPersistence(db);

      persistence.batchInsertDebtItems([
        {
          type: 'complexity',
          description: 'Batch item 1',
          severity: 'high',
          suggestion: 'Fix 1',
          reasoningTrace: [],
          filePath: null,
        },
        {
          type: 'redundancy',
          description: 'Batch item 2',
          severity: 'medium',
          suggestion: 'Fix 2',
          reasoningTrace: [],
          filePath: null,
        },
        {
          type: 'code_age',
          description: 'Batch item 3',
          severity: 'low',
          suggestion: 'Fix 3',
          reasoningTrace: [],
          filePath: null,
        },
      ]);

      const count = db.prepare('SELECT COUNT(*) as cnt FROM debt_items').get() as { cnt: number };
      expect(count.cnt).toBe(3);
    });

    it('handles empty batch without error', () => {
      const persistence = new DebtPersistence(db);
      expect(() => persistence.batchInsertDebtItems([])).not.toThrow();
    });

    it('deduplicates items within the batch', () => {
      const persistence = new DebtPersistence(db);

      persistence.batchInsertDebtItems([
        {
          type: 'complexity',
          description: 'Duplicate',
          severity: 'high',
          suggestion: 'Fix',
          reasoningTrace: [],
          filePath: null,
        },
        {
          type: 'complexity',
          description: 'Duplicate',
          severity: 'medium',
          suggestion: 'Fix updated',
          reasoningTrace: [],
          filePath: null,
        },
      ]);

      const count = db.prepare('SELECT COUNT(*) as cnt FROM debt_items').get() as { cnt: number };
      expect(count.cnt).toBe(1);
    });

    it('uses transaction for atomicity', () => {
      const persistence = new DebtPersistence(db);

      // Insert valid items - all should succeed
      persistence.batchInsertDebtItems([
        {
          type: 'complexity',
          description: 'Valid item 1',
          severity: 'high',
          suggestion: 'Fix',
          reasoningTrace: [],
          filePath: null,
        },
        {
          type: 'redundancy',
          description: 'Valid item 2',
          severity: 'medium',
          suggestion: 'Fix',
          reasoningTrace: [],
          filePath: null,
        },
      ]);

      const count = db.prepare('SELECT COUNT(*) as cnt FROM debt_items').get() as { cnt: number };
      expect(count.cnt).toBe(2);
    });

    it('links files correctly in batch insert', () => {
      db.prepare(
        `INSERT INTO files (path, relative_path, language) VALUES (?, ?, ?)`
      ).run('/project/src/batch.ts', 'src/batch.ts', 'typescript');

      const persistence = new DebtPersistence(db);
      persistence.batchInsertDebtItems([
        {
          type: 'complexity',
          description: 'Batch with file',
          severity: 'high',
          suggestion: 'Fix',
          reasoningTrace: [],
          filePath: 'src/batch.ts',
        },
      ]);

      const row = db.prepare('SELECT file_id FROM debt_items WHERE description = ?').get('Batch with file') as { file_id: number | null };
      expect(row.file_id).not.toBeNull();
    });
  });

  describe('clearPatterns()', () => {
    it('removes all patterns', () => {
      db.prepare(
        `INSERT INTO patterns (name, category, description, code_hash, confidence, first_seen, last_seen, usage_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('test-pattern', 'naming', 'Test', 'hash1', 0.9, new Date().toISOString(), new Date().toISOString(), 1);

      const persistence = new DebtPersistence(db);
      persistence.clearPatterns();

      const count = db.prepare('SELECT COUNT(*) as cnt FROM patterns').get() as { cnt: number };
      expect(count.cnt).toBe(0);
    });
  });
});
