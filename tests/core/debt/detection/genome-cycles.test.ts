import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { GenomeComputer } from '../../../../src/core/debt/detection/genome.js';
import { KnowledgeGraph } from '../../../../src/storage/knowledge-graph.js';
import { SCHEMA_SQL } from '../../../../src/storage/schema.js';

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

function createMockKg(cycles?: string[][]): KnowledgeGraph {
  return {
    getAllFiles: () => [],
    getAgentSessions: () => [],
    findCircularDependencies: () => cycles ?? [],
  } as unknown as KnowledgeGraph;
}

describe('GenomeComputer circular dependency evidence', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('applies a bounded penalty when live circular dependencies exist', () => {
    const computer = new GenomeComputer(createMockKg([['a.ts', 'b.ts']]), db);
    const result = computer.compute();

    expect(result.breakdown.circularDepPenalty).toBeCloseTo(0.05, 2);
  });

  it('caps the live circular dependency penalty at 0.2', () => {
    const cycles = Array.from({ length: 10 }, (_, index) => [`cycle${index}`, 'a.ts']);
    const computer = new GenomeComputer(createMockKg(cycles), db);
    const result = computer.compute();

    expect(result.breakdown.circularDepPenalty).toBeLessThanOrEqual(0.2);
  });

  it('returns no penalty when the live graph is clean', () => {
    const computer = new GenomeComputer(createMockKg(), db);
    const result = computer.compute();

    expect(result.breakdown.circularDepPenalty).toBe(0);
  });

  it('ignores stale persisted cycles when the live graph is clean', () => {
    db.prepare(
      `INSERT INTO circular_dependencies (cycle_path, file_count)
       VALUES (?, ?)`,
    ).run('old.ts -> removed.ts -> old.ts', 2);

    const computer = new GenomeComputer(createMockKg(), db);
    const result = computer.compute();

    expect(result.breakdown.circularDepPenalty).toBe(0);
  });

  it('does not infer a cycle penalty from history when live graph evidence is unavailable', () => {
    db.prepare(
      `INSERT INTO circular_dependencies (cycle_path, file_count)
       VALUES (?, ?)`,
    ).run('legacy.ts -> deleted.ts -> legacy.ts', 2);

    const kg = {
      getAllFiles: () => [],
      getAgentSessions: () => [],
    } as unknown as KnowledgeGraph;
    const computer = new GenomeComputer(kg, db);
    const result = computer.compute();

    expect(result.breakdown.circularDepPenalty).toBe(0);
  });
});
