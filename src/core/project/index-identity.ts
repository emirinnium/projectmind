import type { DatabaseSync } from 'node:sqlite';
import type { WorktreeIdentity } from './worktree-identity.js';
import { canonicalIdentityPath } from './worktree-identity.js';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export interface StoredWorktreeIdentity extends WorktreeIdentity {
  id: number;
  projectId: number;
  lastSeenAt: string;
}

export interface WorktreeNamespaceStatus {
  status: 'current' | 'head-changed' | 'untracked' | 'unavailable';
  current: WorktreeIdentity | null;
  stored: StoredWorktreeIdentity | null;
  nextAction: string;
}

export interface WorktreeProjectSelection {
  projectId: number;
  created: boolean;
  name: string;
}

/**
 * Keep the identity helper safe for injected/embedded databases that were
 * created from SCHEMA_SQL without running the full migration runner. The
 * normal CLI path already creates this table in migration 106; IF NOT EXISTS
 * makes the direct KnowledgeGraph integration path converge without changing
 * existing rows.
 */
export function ensureWorktreeIdentityTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_worktrees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      repository_root TEXT NOT NULL,
      common_git_dir TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      namespace_key TEXT NOT NULL UNIQUE,
      last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, worktree_path, head_sha),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_project_worktrees_project
      ON project_worktrees(project_id, last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_project_worktrees_repository
      ON project_worktrees(repository_root, worktree_path);
  `);
}

function sameIdentityPath(left: string, right: string): boolean {
  return canonicalIdentityPath(left) === canonicalIdentityPath(right);
}

function safeProjectName(identity: WorktreeIdentity): string {
  const repositoryName =
    basename(identity.repositoryRoot).replace(/[^A-Za-z0-9._-]+/g, '-') || 'project';
  const branchName =
    identity.branch === '(detached HEAD)'
      ? `detached-${identity.headSha.slice(0, 8)}`
      : identity.branch.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${repositoryName}@${branchName}`.slice(0, 180);
}

function uniqueProjectName(db: DatabaseSync, identity: WorktreeIdentity): string {
  const base = safeProjectName(identity);
  const pathHash = createHash('sha256')
    .update(
      `${canonicalIdentityPath(identity.repositoryRoot)}::${canonicalIdentityPath(identity.worktreePath)}`,
    )
    .digest('hex')
    .slice(0, 8);
  const candidates = [base, `${base}-${pathHash}`];
  for (const candidate of candidates) {
    const row = db.prepare('SELECT id FROM projects WHERE name = ?').get(candidate) as
      { id: number } | undefined;
    if (!row) return candidate;
  }
  return `${base}-${pathHash}-${identity.headSha.slice(0, 8)}`.slice(0, 220);
}

/**
 * Select the stable ProjectMind project namespace for the active Git
 * worktree/branch. A HEAD change stays inside the same project; a different
 * worktree or branch receives a separate project so graph rows cannot bleed
 * across checkouts. This function never changes Git state.
 */
export function selectOrCreateWorktreeProject(
  db: DatabaseSync,
  identity: WorktreeIdentity,
  configuredRoot: string,
): WorktreeProjectSelection {
  const rows = listWorktreeIdentities(db);
  const exactBranch = rows.find(
    (row) =>
      sameIdentityPath(row.repositoryRoot, identity.repositoryRoot) &&
      sameIdentityPath(row.worktreePath, identity.worktreePath) &&
      row.branch === identity.branch,
  );
  if (exactBranch) {
    recordWorktreeIdentity(db, exactBranch.projectId, identity);
    const project = db
      .prepare('SELECT name FROM projects WHERE id = ?')
      .get(exactBranch.projectId) as { name: string } | undefined;
    return { projectId: exactBranch.projectId, created: false, name: project?.name ?? 'project' };
  }

  // Adopt an explicitly created project whose root is this physical worktree,
  // but only when that project has not already been assigned to another
  // branch/worktree namespace.
  const configured = canonicalIdentityPath(configuredRoot);
  const projects = db
    .prepare('SELECT id, name, root_path FROM projects ORDER BY id')
    .all() as Array<{
    id: number;
    name: string;
    root_path: string;
  }>;
  const adoptable = projects.find(
    (project) =>
      sameIdentityPath(project.root_path, identity.worktreePath) &&
      !rows.some(
        (row) =>
          row.projectId === project.id &&
          sameIdentityPath(row.repositoryRoot, identity.repositoryRoot) &&
          sameIdentityPath(row.worktreePath, identity.worktreePath),
      ),
  );
  if (adoptable && sameIdentityPath(configured, identity.worktreePath)) {
    recordWorktreeIdentity(db, adoptable.id, identity);
    return { projectId: adoptable.id, created: false, name: adoptable.name };
  }

  const name = uniqueProjectName(db, identity);
  const result = db
    .prepare('INSERT INTO projects (name, root_path, description) VALUES (?, ?, ?)')
    .run(
      name,
      identity.worktreePath,
      `Automatic branch/worktree namespace for ${identity.branch}.`,
    );
  const projectId = Number(result.lastInsertRowid);
  recordWorktreeIdentity(db, projectId, identity);
  return { projectId, created: true, name };
}

/** Persist the active repository/worktree/head namespace without changing Git state. */
export function recordWorktreeIdentity(
  db: DatabaseSync,
  projectId: number,
  identity: WorktreeIdentity,
): StoredWorktreeIdentity {
  ensureWorktreeIdentityTable(db);
  const owner = db
    .prepare('SELECT id, project_id FROM project_worktrees WHERE namespace_key = ?')
    .get(identity.key) as { id: number; project_id: number } | undefined;
  if (owner && Number(owner.project_id) !== projectId) {
    throw new Error(
      `Worktree namespace is owned by project ${owner.project_id}; refusing to reassign it to project ${projectId}.`,
    );
  }

  // Older databases persisted an upper-case Windows path in namespace_key.
  // The current identity is intentionally lower-case on Windows, so a plain
  // ON CONFLICT(namespace_key) would miss the old row and hit the table's
  // second UNIQUE(project_id, worktree_path, head_sha) constraint instead.
  // Find the logical row first and repair its representation in place.
  const equivalent = listWorktreeIdentities(db).find(
    (row) =>
      row.projectId === projectId &&
      sameIdentityPath(row.repositoryRoot, identity.repositoryRoot) &&
      sameIdentityPath(row.worktreePath, identity.worktreePath) &&
      row.headSha.toLowerCase() === identity.headSha.toLowerCase(),
  );
  if (equivalent) {
    if (owner && owner.id !== equivalent.id) {
      throw new Error(
        `Worktree namespace ${identity.key} is already owned by another stored identity.`,
      );
    }
    db.prepare(
      `UPDATE project_worktrees SET
         repository_root = ?, common_git_dir = ?, worktree_path = ?, branch = ?,
         head_sha = ?, namespace_key = ?, last_seen_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(
      identity.repositoryRoot,
      identity.commonGitDir,
      identity.worktreePath,
      identity.branch,
      identity.headSha,
      identity.key,
      equivalent.id,
    );
  } else {
    db.prepare(
      `INSERT INTO project_worktrees
        (project_id, repository_root, common_git_dir, worktree_path, branch, head_sha, namespace_key, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(namespace_key) DO UPDATE SET
         project_id = excluded.project_id,
         repository_root = excluded.repository_root,
         common_git_dir = excluded.common_git_dir,
         worktree_path = excluded.worktree_path,
         branch = excluded.branch,
         head_sha = excluded.head_sha,
         last_seen_at = CURRENT_TIMESTAMP`,
    ).run(
      projectId,
      identity.repositoryRoot,
      identity.commonGitDir,
      identity.worktreePath,
      identity.branch,
      identity.headSha,
      identity.key,
    );
  }
  const row = db
    .prepare(
      `SELECT id, project_id, repository_root, common_git_dir, worktree_path, branch,
              head_sha, namespace_key, last_seen_at
       FROM project_worktrees WHERE namespace_key = ?`,
    )
    .get(identity.key) as
    | {
        id: number;
        project_id: number;
        repository_root: string;
        common_git_dir: string;
        worktree_path: string;
        branch: string;
        head_sha: string;
        namespace_key: string;
        last_seen_at: string;
      }
    | undefined;
  if (!row) throw new Error('Project worktree identity was not persisted.');
  return {
    id: row.id,
    projectId: row.project_id,
    repositoryRoot: row.repository_root,
    commonGitDir: row.common_git_dir,
    worktreePath: row.worktree_path,
    branch: row.branch,
    headSha: row.head_sha,
    key: row.namespace_key,
    lastSeenAt: row.last_seen_at,
  };
}

export function listWorktreeIdentities(
  db: DatabaseSync,
  projectId?: number,
): StoredWorktreeIdentity[] {
  ensureWorktreeIdentityTable(db);
  const rows = (
    projectId === undefined
      ? db
          .prepare(
            `SELECT id, project_id, repository_root, common_git_dir, worktree_path, branch,
                head_sha, namespace_key, last_seen_at
         FROM project_worktrees ORDER BY last_seen_at DESC, namespace_key`,
          )
          .all()
      : db
          .prepare(
            `SELECT id, project_id, repository_root, common_git_dir, worktree_path, branch,
                  head_sha, namespace_key, last_seen_at
           FROM project_worktrees WHERE project_id = ?
           ORDER BY last_seen_at DESC, namespace_key`,
          )
          .all(projectId)
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    projectId: Number(row.project_id),
    repositoryRoot: String(row.repository_root),
    commonGitDir: String(row.common_git_dir),
    worktreePath: String(row.worktree_path),
    branch: String(row.branch),
    headSha: String(row.head_sha),
    key: String(row.namespace_key),
    lastSeenAt: String(row.last_seen_at),
  }));
}

/**
 * Compare the active Git identity with the last namespace recorded for the
 * same repository/worktree. A changed HEAD must be visible to callers before
 * they trust an index; it is never silently treated as the current branch.
 */
export function getWorktreeNamespaceStatus(
  db: DatabaseSync,
  projectId: number,
  identity: WorktreeIdentity | null,
): WorktreeNamespaceStatus {
  if (!identity) {
    return {
      status: 'unavailable',
      current: null,
      stored: null,
      nextAction: 'Run this command inside a readable Git worktree, then run pm scan --full.',
    };
  }
  const exact = listWorktreeIdentities(db, projectId).find((row) => row.key === identity.key);
  if (exact) {
    return {
      status: 'current',
      current: identity,
      stored: exact,
      nextAction: 'The recorded worktree namespace matches the current HEAD.',
    };
  }
  const prior = listWorktreeIdentities(db, projectId).find(
    (row) =>
      sameIdentityPath(row.repositoryRoot, identity.repositoryRoot) &&
      sameIdentityPath(row.worktreePath, identity.worktreePath),
  );
  if (prior) {
    return {
      status: 'head-changed',
      current: identity,
      stored: prior,
      nextAction:
        'Run pm scan --full to rebuild the index for the current HEAD before trusting results.',
    };
  }
  return {
    status: 'untracked',
    current: identity,
    stored: null,
    nextAction: 'Run pm project current to record this worktree, then pm scan --full.',
  };
}

/** Remove only old namespaces owned by one project; other projects are untouched. */
export function pruneWorktreeIdentities(
  db: DatabaseSync,
  projectId: number,
  keepKeys: readonly string[],
): number {
  const result = db
    .prepare(
      `DELETE FROM project_worktrees
       WHERE project_id = ? AND namespace_key NOT IN (${keepKeys.map(() => '?').join(',') || "''"})`,
    )
    .run(projectId, ...keepKeys);
  return Number(result.changes);
}
