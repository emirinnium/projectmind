import type { DatabaseSync } from 'node:sqlite';
import type { WorktreeIdentity } from './worktree-identity.js';

export interface StoredWorktreeIdentity extends WorktreeIdentity {
  id: number;
  projectId: number;
  lastSeenAt: string;
}

/** Persist the active repository/worktree/head namespace without changing Git state. */
export function recordWorktreeIdentity(
  db: DatabaseSync,
  projectId: number,
  identity: WorktreeIdentity,
): StoredWorktreeIdentity {
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
