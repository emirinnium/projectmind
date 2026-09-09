import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { getVecIndex, VecIndex, VectorIndex } from '../../../src/core/embeddings/vector-index.js';
import { SCHEMA_SQL } from '../../../src/storage/schema.js';

/**
 * F0-1: sqlite-vec must be loaded through an ESM-safe `require`.
 *
 * The exact availability of the native sqlite-vec binary differs across
 * machines/CI, so these tests do NOT hardcode an expected true/false. They
 * assert that `isAvailable()` is CONSISTENT with the real capability of the
 * connection:
 *   - available  → the vec0 virtual-table module genuinely works.
 *   - unavailable → every VecIndex operation degrades gracefully and the
 *                   brute-force (in-memory cosine) fallback still returns
 *                   correct results.
 */
describe('VecIndex — sqlite-vec availability consistency (F0-1)', () => {
  const DIM = 8;

  function createDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:', { allowExtension: true });
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    return db;
  }

  it('isAvailable() === true implies the vec0 module really works', () => {
    const db = createDb();
    const vecIndex = new VecIndex(db, DIM);

    if (!vecIndex.isAvailable()) {
      // Not available on this machine — covered by the sibling test.
      db.close();
      return;
    }

    // The virtual table created during init must exist.
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pm_vec_files'")
      .get();
    expect(table).toBeDefined();

    // CREATE VIRTUAL TABLE ... USING vec0 must succeed (module truly loaded).
    expect(() =>
      db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS pm_vec_probe USING vec0(embedding float[8])'),
    ).not.toThrow();

    // Round-trip: insert + MATCH query returns the inserted row.
    const probe = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
    db.prepare('INSERT INTO pm_vec_probe(rowid, embedding) VALUES (?, ?)').run(BigInt(1), probe);
    const rows = db
      .prepare(
        'SELECT rowid, distance FROM pm_vec_probe WHERE embedding MATCH ? ORDER BY distance LIMIT ?',
      )
      .all(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]), 5) as Array<{
      rowid: bigint;
      distance: number;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(Number(rows[0].rowid)).toBe(1);

    // The index itself round-trips an upsert + findSimilar.
    vecIndex.upsert(1, [1, 0, 0, 0, 0, 0, 0, 0]);
    const results = vecIndex.findSimilar([1, 0, 0, 0, 0, 0, 0, 0], 5);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(1);

    db.close();
  });

  it('isAvailable() === false implies graceful degradation + working brute-force fallback', () => {
    const db = createDb();
    const vecIndex = new VecIndex(db, DIM);

    if (vecIndex.isAvailable()) {
      // Available on this machine — covered by the sibling test.
      db.close();
      return;
    }

    // Read/write operations must never throw and must degrade to no-ops.
    expect(() => vecIndex.upsert(1, [1, 0, 0, 0, 0, 0, 0, 0])).not.toThrow();
    expect(() => vecIndex.remove(1)).not.toThrow();
    expect(() => vecIndex.rebuild()).not.toThrow();
    expect(vecIndex.findSimilar([1, 0, 0, 0, 0, 0, 0, 0], 5)).toEqual([]);

    // The brute-force (in-memory cosine) fallback still returns correct,
    // sorted results even without the native extension.
    const brute = new VectorIndex();
    brute.addVector('a', [1, 0, 0, 0, 0, 0, 0, 0]);
    brute.addVector('b', [0, 1, 0, 0, 0, 0, 0, 0]);
    const results = brute.findSimilar([1, 0, 0, 0, 0, 0, 0, 0], 5);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe('a');
    expect(results[0].score).toBeCloseTo(1, 5);

    db.close();
  });

  it('init against a real in-memory DB never throws regardless of availability', () => {
    const db = createDb();
    expect(() => new VecIndex(db, DIM)).not.toThrow();
    db.close();
  });

  it('keeps brute-force scores finite for zero and non-finite vectors', () => {
    const brute = new VectorIndex();
    brute.addVector('zero', [0, 0]);
    brute.addVector('unit', [1, 0]);
    brute.addVector('invalid', [Number.NaN, 0]);

    const results = brute.findSimilar([0, 0], 5);

    expect(results).toHaveLength(3);
    expect(results.every((result) => Number.isFinite(result.score))).toBe(true);
    expect(results.find((result) => result.id === 'zero')?.score).toBe(0);
    expect(results.find((result) => result.id === 'invalid')?.score).toBe(0);
  });

  it('rebuilds the first sqlite-vec index from legacy JSON and BLOB rows', () => {
    const db = createDb();
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(
      1,
      'default',
      '/test',
    );
    const legacy = [1, 0, 0, 0, 0, 0, 0, 0];
    const current = [0, 1, 0, 0, 0, 0, 0, 0];
    db.prepare(
      `INSERT INTO files (id, project_id, path, relative_path, language, embedding)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(1, 1, '/test/legacy.ts', 'legacy.ts', 'typescript', JSON.stringify(legacy));
    db.prepare(
      `INSERT INTO files (id, project_id, path, relative_path, language, embedding)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      2,
      1,
      '/test/current.ts',
      'current.ts',
      'typescript',
      Buffer.from(new Float32Array(current).buffer),
    );

    const vecIndex = new VecIndex(db, DIM);
    if (!vecIndex.isAvailable()) {
      db.close();
      return;
    }

    const results = vecIndex.findSimilar(legacy, 5, 1);
    expect(results.map((result) => result.id)).toEqual([1, 2]);
    expect(results[0].distance).toBeCloseTo(0, 5);
    db.close();
  });

  it('keeps the persistent index dimension aligned with the requested vectors', () => {
    const db = createDb();
    const first = getVecIndex(db, DIM);
    expect(first.dimension()).toBe(DIM);
    expect(getVecIndex(db).dimension()).toBe(DIM);

    const second = getVecIndex(db, DIM * 2);
    expect(second.dimension()).toBe(DIM * 2);
    expect(getVecIndex(db).dimension()).toBe(DIM * 2);
    db.close();
  });
});
