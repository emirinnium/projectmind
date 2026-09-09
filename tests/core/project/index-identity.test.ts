import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../../src/storage/schema.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  listWorktreeIdentities,
  pruneWorktreeIdentities,
  recordWorktreeIdentity,
} from '../../../src/core/project/index-identity.js';

describe('project/worktree index identity', () => {
  it('persists and updates one namespace without touching another project', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(1, 'one', '/one');
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(2, 'two', '/two');
    const identity = {
      repositoryRoot: '/repo',
      commonGitDir: '/repo/.git',
      worktreePath: '/one',
      branch: 'main',
      headSha: 'a'.repeat(40),
      key: '/repo::/one::' + 'a'.repeat(40),
    };
    const other = {
      ...identity,
      worktreePath: '/two',
      key: '/repo::/two::' + 'b'.repeat(40),
      headSha: 'b'.repeat(40),
    };
    expect(recordWorktreeIdentity(db, 1, identity).projectId).toBe(1);
    expect(recordWorktreeIdentity(db, 2, other).projectId).toBe(2);
    expect(listWorktreeIdentities(db)).toHaveLength(2);
    expect(pruneWorktreeIdentities(db, 1, [identity.key])).toBe(0);
    expect(listWorktreeIdentities(db, 2)).toHaveLength(1);
    db.close();
  });
});
