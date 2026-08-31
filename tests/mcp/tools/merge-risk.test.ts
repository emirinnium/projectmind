import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { initDatabase, closeDatabase } from '../../../src/storage/database.js';
import { KnowledgeGraph } from '../../../src/storage/kg/graph.js';
import { predictMergeRiskForTool } from '../../../src/mcp/tools/merge-risk.js';
import type { McpDependencies } from '../../../src/mcp/tools/types.js';

/**
 * Seed a knowledge graph where `a.ts` and `b.ts` both import `shared.ts`.
 * Editing `shared.ts` therefore has a blast radius of {a.ts, b.ts} — the
 * reverse-dependency closure the merge-risk engine walks (getImpactRadius).
 *
 * Rows are inserted with raw SQL (mirroring tests/unit/knowledge-graph.test.ts)
 * so the test never depends on the embedding/vec-index machinery that
 * `upsertFile` would pull in.
 */
function seedBlastRadius(db: DatabaseSync): void {
  const insertFile = db.prepare(
    'INSERT INTO files (project_id, path, relative_path, language, size_bytes, hash) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insertFile.run(1, '/test/shared.ts', 'shared.ts', 'typescript', 10, 'h-shared');
  insertFile.run(1, '/test/a.ts', 'a.ts', 'typescript', 10, 'h-a');
  insertFile.run(1, '/test/b.ts', 'b.ts', 'typescript', 10, 'h-b');

  const fileId = (relativePath: string): number =>
    (db.prepare('SELECT id FROM files WHERE relative_path = ?').get(relativePath) as { id: number }).id;

  const insertImport = db.prepare(
    'INSERT INTO imports (file_id, source, kind, resolved, resolved_path) VALUES (?, ?, ?, ?, ?)'
  );
  insertImport.run(fileId('a.ts'), './shared', 'relative', 1, 'shared.ts');
  insertImport.run(fileId('b.ts'), './shared', 'relative', 1, 'shared.ts');
}

describe('predict_merge_risk (predictMergeRiskForTool)', () => {
  let kg: KnowledgeGraph;
  let db: DatabaseSync;
  let deps: McpDependencies;

  beforeAll(() => {
    // initDatabase(':memory:') installs the singleton connection that the KG
    // helper functions reach through getStatement()/getDatabase(), so the
    // graph traversal and file lookups always operate on this same DB.
    db = initDatabase(':memory:');
    kg = new KnowledgeGraph(db);
    seedBlastRadius(db);
    deps = { kg } as McpDependencies;
  });

  afterAll(() => {
    closeDatabase();
  });

  it('flags high risk when the other agent holds files inside my blast radius', () => {
    const result = predictMergeRiskForTool(deps, {
      myFiles: ['shared.ts'],
      otherHeldFiles: ['a.ts', 'b.ts'],
    });

    expect(result.level).toBe('high');
    expect(result.score).toBeGreaterThanOrEqual(4);
    const blastReasons = result.reasons.filter((r) => r.includes('Blast-radius overlap'));
    expect(blastReasons).toHaveLength(2);
    expect(blastReasons[0]).toContain('a.ts');
    expect(blastReasons[1]).toContain('b.ts');
  });

  it('flags medium risk when I edit a file that imports a file the other agent holds', () => {
    const result = predictMergeRiskForTool(deps, {
      myFiles: ['a.ts'],
      otherHeldFiles: ['shared.ts'],
    });

    expect(result.level).toBe('medium');
    expect(result.score).toBe(1);
    expect(result.reasons.some((r) => r.includes('Shared dependency'))).toBe(true);
  });

  it('returns low risk with no reasons when there is no overlap', () => {
    const result = predictMergeRiskForTool(deps, {
      myFiles: ['a.ts'],
      otherHeldFiles: ['b.ts'],
    });

    expect(result.level).toBe('low');
    expect(result.score).toBe(0);
    expect(result.reasons).toHaveLength(0);
  });
});