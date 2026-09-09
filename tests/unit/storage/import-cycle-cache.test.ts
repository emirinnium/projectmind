import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  findCircularDependencies,
  invalidateCircularDependencyCache,
} from '@/storage/kg/helpers/imports.js';
import { SCHEMA_SQL } from '@/storage/schema.js';

function createCycleDatabase(): { db: DatabaseSync; projectId: number } {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  const project = db
    .prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)')
    .run('cycle-cache-project', '/cycle-cache') as { lastInsertRowid: number | bigint };
  const projectId = Number(project.lastInsertRowid);
  const insertFile = db.prepare(
    `INSERT INTO files (project_id, path, relative_path, language, size_bytes, hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const first = insertFile.run(projectId, '/cycle-cache/a.ts', 'a.ts', 'typescript', 10, 'a') as {
    lastInsertRowid: number | bigint;
  };
  const second = insertFile.run(projectId, '/cycle-cache/b.ts', 'b.ts', 'typescript', 10, 'b') as {
    lastInsertRowid: number | bigint;
  };
  const insertImport = db.prepare(
    'INSERT INTO imports (file_id, source, kind, resolved, resolved_path) VALUES (?, ?, ?, ?, ?)',
  );
  insertImport.run(Number(first.lastInsertRowid), './b', 'import', 1, 'b.ts');
  insertImport.run(Number(second.lastInsertRowid), './a', 'import', 1, 'a.ts');
  return { db, projectId };
}

describe('circular dependency cache', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    ({ db } = createCycleDatabase());
    invalidateCircularDependencyCache();
  });

  afterEach(() => {
    db.close();
    invalidateCircularDependencyCache();
  });

  it('does not return a removed cycle from the cached result', () => {
    const context = { db, currentProjectId: 1, projectRoot: '/cycle-cache' };
    expect(findCircularDependencies(context)).toEqual([['a.ts', 'b.ts']]);

    db.prepare("DELETE FROM imports WHERE source = './a'").run();
    invalidateCircularDependencyCache();

    expect(findCircularDependencies(context)).toEqual([]);
  });
});
