import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateCrossProjectRows } from '../../scripts/benchmark/cross-project.mjs';
import { evaluateCrossProjectRegression } from '../../scripts/benchmark/check-cross-project-regression.mjs';
import { SCHEMA_SQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/migrations.js';

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(SCHEMA_SQL);
  runMigrations(database);
  return database;
}

describe('cross-project maintainer evaluator', () => {
  it('keeps identical relative paths isolated and records shared-path evidence', () => {
    const database = createDatabase();
    const root = process.cwd();
    const firstRoot = join(root, 'fixture-project-a');
    const secondRoot = join(root, 'fixture-project-b');
    database
      .prepare(
        'INSERT INTO files (project_id, path, relative_path, hash, size_bytes) VALUES (?, ?, ?, ?, ?)',
      )
      .run(2, join(firstRoot, 'src', 'index.ts'), 'src/index.ts', 'a'.repeat(64), 10);
    database
      .prepare(
        'INSERT INTO files (project_id, path, relative_path, hash, size_bytes) VALUES (?, ?, ?, ?, ?)',
      )
      .run(3, join(secondRoot, 'src', 'index.ts'), 'src/index.ts', 'b'.repeat(64), 11);

    const result = evaluateCrossProjectRows(database, [
      { projectId: 2, repositoryId: 'alpha', checkoutPath: firstRoot },
      { projectId: 3, repositoryId: 'beta', checkoutPath: secondRoot },
    ]);

    expect(result.passed).toBe(true);
    expect(result.projectIdsAreDistinct).toBe(true);
    expect(result.everyProjectHasRows).toBe(true);
    expect(result.allPathsConfined).toBe(true);
    expect(result.overlappingRelativePaths).toEqual([
      { relativePath: 'src/index.ts', projectIds: [2, 3] },
    ]);
    database.close();
  });

  it('fails closed when one stored path escapes its project checkout', () => {
    const database = createDatabase();
    const root = process.cwd();
    const firstRoot = join(root, 'fixture-project-a');
    const secondRoot = join(root, 'fixture-project-b');
    database
      .prepare(
        'INSERT INTO files (project_id, path, relative_path, hash, size_bytes) VALUES (?, ?, ?, ?, ?)',
      )
      .run(2, join(firstRoot, 'src', 'index.ts'), 'src/index.ts', 'a'.repeat(64), 10);
    database
      .prepare(
        'INSERT INTO files (project_id, path, relative_path, hash, size_bytes) VALUES (?, ?, ?, ?, ?)',
      )
      .run(3, join(firstRoot, 'private.ts'), 'private.ts', 'b'.repeat(64), 11);

    const result = evaluateCrossProjectRows(database, [
      { projectId: 2, repositoryId: 'alpha', checkoutPath: firstRoot },
      { projectId: 3, repositoryId: 'beta', checkoutPath: secondRoot },
    ]);

    expect(result.passed).toBe(false);
    expect(result.allPathsConfined).toBe(false);
    database.close();
  });

  it('regression gate requires the selected repositories and passing invariants', () => {
    const current = {
      evaluator: { name: 'projectmind-cli-cross-project-isolation' },
      manifest: { repositories: ['zod', 'execa'] },
      isolation: { passed: true },
      projects: [
        {
          repositoryId: 'zod',
          expectedCommit: 'a'.repeat(40),
          actualCommit: 'a'.repeat(40),
          scan: { errors: 0 },
        },
        {
          repositoryId: 'execa',
          expectedCommit: 'b'.repeat(40),
          actualCommit: 'b'.repeat(40),
          scan: { errors: 0 },
        },
      ],
    };
    const baseline = {
      evaluatorName: 'projectmind-cli-cross-project-isolation',
      repositories: ['execa', 'zod'],
      requirePassed: true,
      requireCommitParity: true,
      maxScanErrors: 0,
    };
    expect(evaluateCrossProjectRegression(current, baseline)).toEqual({
      passed: true,
      failures: [],
    });
    expect(
      evaluateCrossProjectRegression({ ...current, isolation: { passed: false } }, baseline).passed,
    ).toBe(false);
  });
});
