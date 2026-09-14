import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseManager } from '../../src/storage/database.js';
import { DebtTracker } from '../../src/core/debt/tracker.js';
import { KnowledgeGraph } from '../../src/storage/knowledge-graph.js';
import { CoherenceEngine } from '../../src/core/coherence/engine.js';
import { closeDatabase } from '../../src/storage/database.js';

let dbManager: DatabaseManager;

describe('DebtTracker', () => {
  let tracker: DebtTracker;

  beforeEach(() => {
    dbManager = new DatabaseManager(':memory:');
    const db = dbManager.init();

    // Mock dependencies
    const kg = {
      getAllFiles: () => [],
      getAgentSessions: () => [],
    };
    const coherenceEngine = {
      analyze: () => ({}),
    };

    tracker = new DebtTracker(db, kg as any, coherenceEngine as any);
  });

  afterEach(() => {
    dbManager.close();
  });

  describe('getReport', () => {
    it('returns an empty debt report when no debt exists', () => {
      const report = tracker.getReport();
      expect(report).toBeDefined();
      expect(report.totalItems).toBe(0);
      expect(report.bySeverity.high).toBe(0);
      expect(report.bySeverity.medium).toBe(0);
      expect(report.bySeverity.low).toBe(0);
      expect(report.items).toHaveLength(0);
    });
  });

  describe('computeGenome', () => {
    it('returns genome data with coherence score', () => {
      const genome = tracker.computeGenome();
      expect(genome).toBeDefined();
      expect(genome.genomeData).toBeDefined();
      expect(typeof genome.coherenceScore).toBe('number');
      expect(genome.coherenceScore).toBeGreaterThanOrEqual(0);
      expect(genome.coherenceScore).toBeLessThanOrEqual(1);
    });
  });

  describe('getCacheStats', () => {
    it('returns cache stats', () => {
      const stats = tracker.getCacheStats();
      expect(stats).toBeDefined();
    });
  });

  describe('clearAllDebt', () => {
    it('clears all debt without error', () => {
      expect(() => tracker.clearAllDebt()).not.toThrow();
    });
  });

  describe('clearPatterns', () => {
    it('clears patterns without error', () => {
      expect(() => tracker.clearPatterns()).not.toThrow();
    });
  });

  describe('detector snapshot refresh', () => {
    it('removes stale unresolved detector findings while preserving resolved history', async () => {
      const db = dbManager.init();
      db.prepare(
        `INSERT INTO debt_items (type, description, severity, suggestion, reasoning_trace, resolved)
         VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
      ).run(
        'pattern_drift',
        'stale pattern',
        'high',
        'Fix',
        '[]',
        0,
        'architectural_drift',
        'stale architecture',
        'high',
        'Fix',
        '[]',
        0,
        'change_frequency',
        'resolved churn',
        'low',
        'Review',
        '[]',
        1,
      );

      const kg = {
        getAllFiles: () => [],
        getAgentSessions: () => [],
        getCurrentProject: () => ({ rootPath: process.cwd() }),
      };
      const isolatedTracker = new DebtTracker(db, kg as any, { analyze: () => ({}) } as any);

      await isolatedTracker.detectDebt();

      const rows = db
        .prepare('SELECT type, description, resolved FROM debt_items ORDER BY id')
        .all() as Array<{ type: string; description: string; resolved: number }>;
      expect(rows).toEqual([
        { type: 'change_frequency', description: 'resolved churn', resolved: 1 },
      ]);
    });
  });

  describe('resolveDebt', () => {
    it('does not throw for non-existent debt id', () => {
      expect(() => tracker.resolveDebt(999)).not.toThrow();
    });
  });
});
