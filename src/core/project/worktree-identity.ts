import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { logger } from '../../utils/logger.js';

export interface WorktreeIdentity {
  repositoryRoot: string;
  commonGitDir: string;
  worktreePath: string;
  branch: string;
  headSha: string;
  key: string;
}

/**
 * Canonicalize a path for identity comparisons without changing the path that
 * is shown to a user or passed to the filesystem. Git can emit mixed
 * separators on Windows, while an existing database may contain the older
 * representation.
 */
export function canonicalIdentityPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** Read repository/worktree identity without changing Git state. */
export function getWorktreeIdentity(projectRoot: string): WorktreeIdentity | null {
  try {
    const root = resolve(projectRoot);
    // Git returns `.git` for the primary worktree but an absolute common-dir
    // path for linked worktrees. Canonicalize both forms before deriving the
    // namespace key so equivalent Windows/POSIX representations cannot split
    // one repository into two identities.
    const repositoryRoot = resolve(root, git(root, ['rev-parse', '--show-toplevel']));
    const commonGitDir = resolve(root, git(root, ['rev-parse', '--git-common-dir']));
    const worktreePath = resolve(root, git(root, ['rev-parse', '--show-toplevel']));
    const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || '(detached HEAD)';
    const headSha = git(root, ['rev-parse', 'HEAD']);
    const key = `${canonicalIdentityPath(repositoryRoot)}::${canonicalIdentityPath(worktreePath)}::${headSha.toLowerCase()}`;
    return { repositoryRoot, commonGitDir, worktreePath, branch, headSha, key };
  } catch (error) {
    logger.debug('Git worktree identity unavailable.', {
      projectRoot,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
