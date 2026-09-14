import { describe, expect, it } from 'vitest';
import { PatternLibrary } from '../../src/parser/pattern-extractor.js';
import { parseFile } from '../../src/parser/ast-parser.js';
import { createIsolatedDatabase } from '../test-helpers/database.js';

describe('PatternLibrary — project isolation', () => {
  it('stores and reads identical patterns independently per project', () => {
    const { db, cleanup } = createIsolatedDatabase();
    try {
      const structure = parseFile(
        '/repo/src/shared.ts',
        'export function sharedName(value: string): string { return value; }',
      );
      expect(structure).not.toBeNull();

      const projectOne = new PatternLibrary(db, 1);
      const projectTwo = new PatternLibrary(db, 2);
      projectOne.extractPatterns(structure!);
      projectTwo.extractPatterns(structure!);

      const one = projectOne.getPatterns();
      const two = projectTwo.getPatterns();
      expect(one.length).toBeGreaterThan(0);
      expect(two.length).toBe(one.length);
      expect(new Set(one.map((pattern) => pattern.id))).not.toEqual(
        new Set(two.map((pattern) => pattern.id)),
      );

      const counts = db
        .prepare('SELECT project_id, COUNT(*) AS count FROM patterns GROUP BY project_id ORDER BY project_id')
        .all() as Array<{ project_id: number; count: number }>;
      expect(counts).toHaveLength(2);
      expect(counts.every((row) => row.count === one.length)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
