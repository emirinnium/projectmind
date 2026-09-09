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

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  }).trim();
}

/** Read repository/worktree identity without changing Git state. */
export function getWorktreeIdentity(projectRoot: string): WorktreeIdentity | null {
  try {
    const root = resolve(projectRoot);
    const repositoryRoot = git(root, ['rev-parse', '--show-toplevel']);
    const commonGitDir = git(root, ['rev-parse', '--git-common-dir']);
    const worktreePath = git(root, ['rev-parse', '--show-toplevel']);
    const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || '(detached HEAD)';
    const headSha = git(root, ['rev-parse', 'HEAD']);
    const key = `${repositoryRoot.replace(/\\/g, '/')}::${worktreePath.replace(/\\/g, '/')}::${headSha}`;
    return { repositoryRoot, commonGitDir, worktreePath, branch, headSha, key };
  } catch (error) {
    logger.debug('Git worktree identity unavailable.', {
      projectRoot,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
