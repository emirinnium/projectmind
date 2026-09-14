import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { SCHEMA_SQL } from '../../../src/storage/schema.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import { getWorktreeIdentity } from '../../../src/core/project/worktree-identity.js';
import {
  getWorktreeNamespaceStatus,
  listWorktreeIdentities,
  pruneWorktreeIdentities,
  recordWorktreeIdentity,
  selectOrCreateWorktreeProject,
} from '../../../src/core/project/index-identity.js';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const itWithGit = gitAvailable() ? it : it.skip;

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

  it('repairs legacy Windows casing without violating the compatibility unique key', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(1, 'one', '/one');
    const legacyRoot = process.platform === 'win32' ? 'C:/Repo' : '\\repo';
    const canonicalRoot = process.platform === 'win32' ? 'c:/repo' : '/repo';
    const legacy = {
      repositoryRoot: legacyRoot,
      commonGitDir: `${legacyRoot}/.git`,
      worktreePath: legacyRoot,
      branch: 'main',
      headSha: 'A'.repeat(40),
      key: `${legacyRoot.replace(/\\/g, '/')}::${legacyRoot.replace(/\\/g, '/')}::` + 'A'.repeat(40),
    };
    db.prepare(
      `INSERT INTO project_worktrees
       (project_id, repository_root, common_git_dir, worktree_path, branch, head_sha, namespace_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, legacyRoot, `${legacyRoot}/.git`, legacyRoot, 'main', 'A'.repeat(40), legacy.key);

    const canonical = {
      ...legacy,
      repositoryRoot: canonicalRoot,
      commonGitDir: `${canonicalRoot}/.git`,
      worktreePath: canonicalRoot,
      headSha: 'a'.repeat(40),
      key: `${canonicalRoot}::${canonicalRoot}::` + 'a'.repeat(40),
    };
    expect(recordWorktreeIdentity(db, 1, canonical).key).toBe(canonical.key);
    expect(listWorktreeIdentities(db, 1)).toHaveLength(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM project_worktrees').get() as { count: number }).count,
    ).toBe(1);
    db.close();
  });

  it('removes stale namespaces only inside the requested project', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(1, 'one', '/one');
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(2, 'two', '/two');

    const current = {
      repositoryRoot: '/repo',
      commonGitDir: '/repo/.git',
      worktreePath: '/one',
      branch: 'main',
      headSha: 'a'.repeat(40),
      key: '/repo::/one::' + 'a'.repeat(40),
    };
    const stale = {
      ...current,
      branch: 'feature',
      headSha: 'b'.repeat(40),
      key: '/repo::/one::' + 'b'.repeat(40),
    };
    const otherProject = {
      ...current,
      worktreePath: '/two',
      headSha: 'c'.repeat(40),
      key: '/repo::/two::' + 'c'.repeat(40),
    };

    recordWorktreeIdentity(db, 1, current);
    recordWorktreeIdentity(db, 1, stale);
    recordWorktreeIdentity(db, 2, otherProject);

    expect(pruneWorktreeIdentities(db, 1, [current.key])).toBe(1);
    expect(listWorktreeIdentities(db, 1).map((row) => row.key)).toEqual([current.key]);
    expect(listWorktreeIdentities(db, 2).map((row) => row.key)).toEqual([otherProject.key]);
    db.close();
  });

  it('refuses to transfer an existing namespace to another project', () => {
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

    recordWorktreeIdentity(db, 1, identity);
    expect(() => recordWorktreeIdentity(db, 2, identity)).toThrow(/refusing to reassign/i);
    expect(listWorktreeIdentities(db, 1)).toHaveLength(1);
    expect(listWorktreeIdentities(db, 2)).toHaveLength(0);
    db.close();
  });

  it('reports a changed HEAD before a new namespace is recorded', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(1, 'one', '/one');
    const first = {
      repositoryRoot: '/repo',
      commonGitDir: '/repo/.git',
      worktreePath: '/one',
      branch: 'main',
      headSha: 'a'.repeat(40),
      key: '/repo::/one::' + 'a'.repeat(40),
    };
    const next = { ...first, headSha: 'b'.repeat(40), key: '/repo::/one::' + 'b'.repeat(40) };
    recordWorktreeIdentity(db, 1, first);

    const status = getWorktreeNamespaceStatus(db, 1, next);
    expect(status.status).toBe('head-changed');
    expect(status.stored?.headSha).toBe(first.headSha);
    expect(status.nextAction).toContain('pm scan --full');
    db.close();
  });

  it('does not claim a namespace for an untracked worktree', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(1, 'one', '/one');
    const identity = {
      repositoryRoot: '/repo',
      commonGitDir: '/repo/.git',
      worktreePath: '/one',
      branch: 'feature',
      headSha: 'c'.repeat(40),
      key: '/repo::/one::' + 'c'.repeat(40),
    };
    const status = getWorktreeNamespaceStatus(db, 1, identity);
    expect(status.status).toBe('untracked');
    expect(status.stored).toBeNull();
    expect(status.nextAction).toContain('pm project current');
    db.close();
  });

  it('selects one stable project per branch and separates linked worktrees', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(1, 'default', '/one');

    const main = {
      repositoryRoot: '/repo',
      commonGitDir: '/repo/.git',
      worktreePath: '/one',
      branch: 'main',
      headSha: 'a'.repeat(40),
      key: '/repo::/one::' + 'a'.repeat(40),
    };
    const mainNext = { ...main, headSha: 'b'.repeat(40), key: '/repo::/one::' + 'b'.repeat(40) };
    const feature = {
      ...main,
      worktreePath: '/linked',
      branch: 'feature/ui',
      headSha: 'c'.repeat(40),
      key: '/repo::/linked::' + 'c'.repeat(40),
    };

    const mainSelection = selectOrCreateWorktreeProject(db, main, '/one');
    const mainAgain = selectOrCreateWorktreeProject(db, mainNext, '/one');
    const featureSelection = selectOrCreateWorktreeProject(db, feature, '/linked');

    expect(mainSelection.created).toBe(false);
    expect(mainAgain.projectId).toBe(mainSelection.projectId);
    expect(featureSelection.projectId).not.toBe(mainSelection.projectId);
    expect(listWorktreeIdentities(db, mainSelection.projectId)).toHaveLength(2);
    expect(listWorktreeIdentities(db, featureSelection.projectId)).toHaveLength(1);
    db.close();
  });

  itWithGit('keeps real linked worktrees isolated and detects a changed HEAD', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-real-worktree-'));
    const linked = join(root, 'linked-worktree');
    const git = (args: string[], cwd = root): string =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();

    try {
      git(['init', '-q']);
      git(['config', 'user.email', 'projectmind-fixture@example.invalid']);
      git(['config', 'user.name', 'ProjectMind Fixture']);
      writeFileSync(join(root, 'index.ts'), 'export const fixture = 1;\n', 'utf8');
      git(['add', 'index.ts']);
      git(['commit', '-qm', 'initial fixture']);
      git(['switch', '-qc', 'fixture-main']);
      git(['worktree', 'add', '-qb', 'fixture-linked', linked]);

      const mainIdentity = getWorktreeIdentity(root);
      const linkedIdentity = getWorktreeIdentity(linked);
      expect(mainIdentity).not.toBeNull();
      expect(linkedIdentity).not.toBeNull();
      expect(mainIdentity?.branch).toBe('fixture-main');
      expect(linkedIdentity?.branch).toBe('fixture-linked');
      expect(normalize(mainIdentity!.worktreePath)).not.toBe(
        normalize(linkedIdentity!.worktreePath),
      );
      expect(mainIdentity!.key).not.toBe(linkedIdentity!.key);
      expect(normalize(mainIdentity!.commonGitDir)).toBe(normalize(linkedIdentity!.commonGitDir));

      const db = new DatabaseSync(':memory:');
      db.exec(SCHEMA_SQL);
      runMigrations(db);
      db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(
        1,
        'main-worktree',
        root,
      );
      db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(
        2,
        'linked-worktree',
        linked,
      );
      recordWorktreeIdentity(db, 1, mainIdentity!);
      recordWorktreeIdentity(db, 2, linkedIdentity!);
      expect(listWorktreeIdentities(db)).toHaveLength(2);

      writeFileSync(join(root, 'index.ts'), 'export const fixture = 2;\n', 'utf8');
      git(['add', 'index.ts']);
      git(['commit', '-qm', 'changed fixture']);
      const changedIdentity = getWorktreeIdentity(root);
      expect(changedIdentity?.headSha).not.toBe(mainIdentity?.headSha);
      expect(getWorktreeNamespaceStatus(db, 1, changedIdentity).status).toBe('head-changed');
      expect(pruneWorktreeIdentities(db, 1, [changedIdentity!.key])).toBe(1);
      expect(listWorktreeIdentities(db, 2)).toHaveLength(1);
      db.close();
    } finally {
      try {
        git(['worktree', 'remove', '--force', linked]);
      } catch {
        // The fixture directory is still removed below if Git cleanup fails.
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
