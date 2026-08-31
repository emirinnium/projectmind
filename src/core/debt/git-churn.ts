import { execFileSync } from 'node:child_process';

export interface GitChurnEntry {
  count: number;
  authors: Set<string>;
}

/**
 * Parse real change frequency from `git log --name-only`.
 * Commit records start with an '@@<author>' sentinel followed by changed
 * file paths, so author lines and file lines can never be confused.
 *
 * Core-local equivalent of `src/cli/utils/git-churn.ts` (used by the churn
 * and refactor-roi commands). Kept inside core so the debt tracker never has
 * to import from the CLI layer (acyclic layering). Degrades gracefully:
 * a missing git binary, a non-repo directory, or any parse failure yields an
 * empty map — this function never throws.
 */
export function collectGitChurn(projectRoot: string, sinceDays: number): Map<string, GitChurnEntry> {
  const churn = new Map<string, GitChurnEntry>();
  try {
    const out = execFileSync(
      'git',
      ['log', `--since=${sinceDays} days ago`, '--pretty=format:@@%an', '--name-only'],
      { cwd: projectRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
    );
    let currentAuthor = 'unknown';
    for (const rawLine of out.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('@@')) {
        currentAuthor = line.slice(2) || 'unknown';
        continue;
      }
      const normalized = line.replace(/\\/g, '/');
      if (!normalized.includes('/')) continue; // skip stray non-path lines
      const entry = churn.get(normalized) ?? { count: 0, authors: new Set<string>() };
      entry.count += 1;
      entry.authors.add(currentAuthor);
      churn.set(normalized, entry);
    }
  } catch {
    // Not a git repo / git missing: change-frequency analysis is skipped.
  }
  return churn;
}
