import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenomeComputer } from '../../../../src/core/debt/detection/genome.js';
import { KnowledgeGraph } from '../../../../src/storage/knowledge-graph.js';
import { SCHEMA_SQL } from '../../../../src/storage/schema.js';

/**
 * Creates a fully-initialized in-memory database with schema for testing.
 */
function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

/**
 * Creates a mock KnowledgeGraph with controllable file and session data.
 */
function createMockKg(opts: {
  files?: Array<{ path: string }>;
  sessions?: unknown[];
}) {
  return {
    getAllFiles: () => opts.files ?? [],
    getAgentSessions: () => opts.sessions ?? [],
  } as unknown as KnowledgeGraph;
}

describe('GenomeComputer', () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    tmpDir = mkdtempSync(join(tmpdir(), 'genome-test-'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('compute() with empty database', () => {
    it('returns a valid genome result with zero patterns', () => {
      const kg = createMockKg({});
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result).toBeDefined();
      expect(result.genomeData).toBeDefined();
      expect(typeof result.coherenceScore).toBe('number');
      expect(result.coherenceScore).toBeGreaterThanOrEqual(0);
      expect(result.coherenceScore).toBeLessThanOrEqual(1);
    });

    it('returns breakdown with zero pattern count', () => {
      const kg = createMockKg({});
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result.breakdown.patternCount).toBe(0);
      expect(result.breakdown.highConfidencePatterns).toBe(0);
    });

    it('returns zero violation penalty with no debt items', () => {
      const kg = createMockKg({});
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result.breakdown.violationPenalty).toBe(0);
    });

    it('returns zero marker count with no files', () => {
      const kg = createMockKg({});
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result.breakdown.markerCount).toBe(0);
    });
  });

  describe('pattern loading from database', () => {
    it('loads patterns from the database and computes avg confidence', () => {
      // Insert test patterns
      db.prepare(
        `INSERT INTO patterns (name, category, description, code_hash, confidence, first_seen, last_seen, usage_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('test-pattern-1', 'naming', 'Test pattern 1', 'hash1', 0.9, new Date().toISOString(), new Date().toISOString(), 5);

      db.prepare(
        `INSERT INTO patterns (name, category, description, code_hash, confidence, first_seen, last_seen, usage_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('test-pattern-2', 'structure', 'Test pattern 2', 'hash2', 0.7, new Date().toISOString(), new Date().toISOString(), 3);

      const kg = createMockKg({});
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result.breakdown.patternCount).toBe(2);
      expect(result.breakdown.avgConfidence).toBeCloseTo(0.8, 1);
    });

    it('counts high confidence patterns (>= 0.8)', () => {
      db.prepare(
        `INSERT INTO patterns (name, category, description, code_hash, confidence, first_seen, last_seen, usage_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('high-conf', 'naming', 'High confidence', 'hash1', 0.95, new Date().toISOString(), new Date().toISOString(), 1);

      db.prepare(
        `INSERT INTO patterns (name, category, description, code_hash, confidence, first_seen, last_seen, usage_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('low-conf', 'naming', 'Low confidence', 'hash2', 0.5, new Date().toISOString(), new Date().toISOString(), 1);

      const kg = createMockKg({});
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result.breakdown.highConfidencePatterns).toBe(1);
    });
  });

  describe('weighted confidence calculation', () => {
    it('weights confidence by usage count', () => {
      // Pattern with high usage should pull weighted average up
      db.prepare(
        `INSERT INTO patterns (name, category, description, code_hash, confidence, first_seen, last_seen, usage_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('heavy-pattern', 'naming', 'Heavy usage', 'hash1', 0.95, new Date().toISOString(), new Date().toISOString(), 100);

      db.prepare(
        `INSERT INTO patterns (name, category, description, code_hash, confidence, first_seen, last_seen, usage_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('light-pattern', 'naming', 'Light usage', 'hash2', 0.3, new Date().toISOString(), new Date().toISOString(), 1);

      const kg = createMockKg({});
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      // Weighted confidence should be closer to 0.95 (heavy pattern dominates)
      expect(result.breakdown.weightedConfidence).toBeGreaterThan(result.breakdown.avgConfidence);
    });
  });

  describe('violation counting logic', () => {
    it('counts high severity unresolved debt items', () => {
      db.prepare(
        `INSERT INTO debt_items (type, description, severity, suggestion, reasoning_trace, resolved)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('complexity', 'High complexity function', 'high', 'Refactor', '[]', 0);

      db.prepare(
        `INSERT INTO debt_items (type, description, severity, suggestion, reasoning_trace, resolved)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('complexity', 'Another high severity', 'high', 'Refactor', '[]', 0);

      const kg = createMockKg({});
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      // 2 violations * 0.02 = 0.04 penalty
      expect(result.breakdown.violationPenalty).toBeCloseTo(0.04, 2);
    });

    it('does not count resolved debt items as violations', () => {
      db.prepare(
        `INSERT INTO debt_items (type, description, severity, suggestion, reasoning_trace, resolved)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('complexity', 'Resolved issue', 'high', 'Refactor', '[]', 1);

      const kg = createMockKg({});
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result.breakdown.violationPenalty).toBe(0);
    });

    it('caps violation penalty at 0.3', () => {
      // Insert 20 high severity items (20 * 0.02 = 0.4, capped at 0.3)
      const stmt = db.prepare(
        `INSERT INTO debt_items (type, description, severity, suggestion, reasoning_trace, resolved)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (let i = 0; i < 20; i++) {
        stmt.run('complexity', `Issue ${i}`, 'high', 'Refactor', '[]', 0);
      }

      const kg = createMockKg({});
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result.breakdown.violationPenalty).toBeLessThanOrEqual(0.3);
    });
  });

  describe('TODO/FIXME marker counting', () => {
    it('counts TODO and FIXME markers in project files', () => {
      const file1 = join(tmpDir, 'file1.ts');
      writeFileSync(file1, `
        // TODO: implement this function
        const x = 1;
        // FIXME: this is broken
        const y = 2;
      `);

      const kg = createMockKg({ files: [{ path: file1 }] });
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result.breakdown.markerCount).toBe(2);
    });

    it('counts TODO with colon separator', () => {
      const file1 = join(tmpDir, 'file1.ts');
      writeFileSync(file1, '// TODO: refactor this module');

      const kg = createMockKg({ files: [{ path: file1 }] });
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result.breakdown.markerCount).toBe(1);
    });

    it('counts FIXME with space separator', () => {
      const file1 = join(tmpDir, 'file1.ts');
      writeFileSync(file1, '// FIXME handle edge case');

      const kg = createMockKg({ files: [{ path: file1 }] });
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result.breakdown.markerCount).toBe(1);
    });

    it('does not count words containing TODO as substring', () => {
      const file1 = join(tmpDir, 'file1.ts');
      writeFileSync(file1, '// This is a TODOlist item\n// TODO: real item');

      const kg = createMockKg({ files: [{ path: file1 }] });
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      // Only "TODO:" should match, not "TODOlist"
      expect(result.breakdown.markerCount).toBe(1);
    });
  });

  describe('circular dependency detection', () => {
    it('applies penalty when circular dependencies exist', () => {
      db.prepare(
        `INSERT INTO circular_dependencies (cycle_path, file_count)
         VALUES (?, ?)`
      ).run('a.ts -> b.ts -> a.ts', 2);

      const kg = createMockKg({});
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      // 1 circular dep * 0.05 = 0.05 penalty
      expect(result.breakdown.circularDepPenalty).toBeCloseTo(0.05, 2);
    });

    it('caps circular dependency penalty at 0.2', () => {
      const stmt = db.prepare(
        `INSERT INTO circular_dependencies (cycle_path, file_count)
         VALUES (?, ?)`
      );
      for (let i = 0; i < 10; i++) {
        stmt.run(`cycle${i}: a.ts -> b.ts -> a.ts`, 2);
      }

      const kg = createMockKg({});
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result.breakdown.circularDepPenalty).toBeLessThanOrEqual(0.2);
    });

    it('returns zero penalty when no circular dependencies', () => {
      const kg = createMockKg({});
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result.breakdown.circularDepPenalty).toBe(0);
    });
  });

  describe('agent coverage bonus calculation', () => {
    it('returns zero bonus with no agent sessions', () => {
      const kg = createMockKg({ sessions: [] });
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result.breakdown.agentSessions).toBe(0);
    });

    it('calculates bonus proportional to session count', () => {
      const sessions = Array(5).fill({ session: 'data' });
      const kg = createMockKg({ sessions });
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result.breakdown.agentSessions).toBe(5);
      // 5/10 = 0.5 coverage, 0.5 * 0.05 = 0.025 bonus
      // Coherence score should reflect this bonus
    });

    it('caps agent bonus at 10 sessions', () => {
      const sessions = Array(15).fill({ session: 'data' });
      const kg = createMockKg({ sessions });
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result.breakdown.agentSessions).toBe(15);
      // Should be capped at 10 for bonus calculation
    });
  });

  describe('genome data persistence', () => {
    it('persists genome data to project_genome table', () => {
      const kg = createMockKg({});
      const computer = new GenomeComputer(kg, db);
      computer.compute();

      const row = db.prepare('SELECT COUNT(*) as cnt FROM project_genome').get() as { cnt: number };
      expect(row.cnt).toBe(1);
    });

    it('prunes genome history to 10 most recent entries', () => {
      const kg = createMockKg({});
      const computer = new GenomeComputer(kg, db);

      // Compute genome 12 times
      for (let i = 0; i < 12; i++) {
        computer.compute();
      }

      const row = db.prepare('SELECT COUNT(*) as cnt FROM project_genome').get() as { cnt: number };
      expect(row.cnt).toBeLessThanOrEqual(10);
    });
  });

  describe('coherence score bounds', () => {
    it('always returns coherence score between 0 and 1', () => {
      // Insert worst-case data
      const debtStmt = db.prepare(
        `INSERT INTO debt_items (type, description, severity, suggestion, reasoning_trace, resolved)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (let i = 0; i < 50; i++) {
        debtStmt.run('complexity', `Issue ${i}`, 'high', 'Fix', '[]', 0);
      }

      const circStmt = db.prepare(
        `INSERT INTO circular_dependencies (cycle_path, file_count)
         VALUES (?, ?)`
      );
      for (let i = 0; i < 20; i++) {
        circStmt.run(`cycle${i}`, 3);
      }

      const kg = createMockKg({});
      const computer = new GenomeComputer(kg, db);
      const result = computer.compute();

      expect(result.coherenceScore).toBeGreaterThanOrEqual(0);
      expect(result.coherenceScore).toBeLessThanOrEqual(1);
    });
  });
});
