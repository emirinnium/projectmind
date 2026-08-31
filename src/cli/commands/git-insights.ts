import { Command } from 'commander';
import { asyncHandler, output } from '@/cli/utils/shared.js';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '@/cli/utils/shared.js';

/**
 * Temporal context for a single file, straight from git:
 *  - author distribution + last-touch date
 *  - rename/refactor history (--follow)
 *  - most recent commit subjects touching the file
 *
 * Gives coding agents the "why does this code look like this" dimension that
 * filesystem snapshots cannot provide. Read-only; never fabricates when a
 * file has no git history.
 */
export function createGitInsightsCommand(): Command {
  return new Command('git-insights')
    .description('Temporal analysis for a file: authors, rename history, recent commits (git)')
    .argument('<file>', 'Relative or absolute file path')
    .option('-n, --commits <n>', 'Number of recent commits to show', '10')
    .option('--format <fmt>', 'Output: text|json', 'text')
    .action(asyncHandler(async (filePath: string, opts: { commits: string; format: string }) => {
      const root = loadConfig().projectRoot;
      const relForGit = filePath.replace(/\\/g, '/');

      const git = (args: string[], maxBuffer = 32 * 1024 * 1024): string | null => {
        try {
          return execFileSync('git', args, { cwd: root, encoding: 'utf-8', maxBuffer }).trim();
        } catch {
          return null;
        }
      };

      const tracked = git(['ls-files', '--error-unmatch', relForGit]) !== null;
      if (!tracked) {
        output.warn(`"${relForGit}" has no git history (untracked or not a git repository).`);
        return;
      }

      // Author distribution + activity timeline.
      const authorLines = (git(['log', '--follow', '--format=%an|%aI', '--', relForGit]) ?? '').split(/\r?\n/).filter(Boolean);
      const authors = new Map<string, number>();
      let lastTouch: string | null = null;
      for (const line of authorLines) {
        const [name, date] = line.split('|');
        if (!name) continue;
        authors.set(name, (authors.get(name) ?? 0) + 1);
        lastTouch = lastTouch ?? date ?? null;
      }

      // Rename/refactor history via --follow name-status.
      const statusBlock = git(['log', '--follow', '--name-status', '--format=@%h', '--', relForGit]) ?? '';
      const renames: Array<{ commit: string; detail: string }> = [];
      let currentCommit = '';
      for (const line of statusBlock.split(/\r?\n/)) {
        if (line.startsWith('@')) currentCommit = line.slice(1).trim();
        else if (/^R\d{3}/.test(line)) renames.push({ commit: currentCommit, detail: line });
      }

      // Recent commit subjects.
      const n = Math.max(1, parseInt(opts.commits, 10));
      const logRaw = git(['log', `-n`, String(n), '--format=%h%x09%an%x09%aI%x09%s', '--', relForGit]) ?? '';
      const commits = logRaw.split(/\r?\n/).filter(Boolean).map((l) => {
        const [hash, author, date, ...subject] = l.split('\t');
        return { hash, author, date, subject: subject.join('\t') };
      });

      const result = {
        file: relForGit,
        tracked: true,
        totalCommits: authorLines.length,
        lastTouched: lastTouch,
        authors: [...authors.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => ({ name, commits: count, share: Math.round((count / authorLines.length) * 100) + '%' })),
        renames,
        recentCommits: commits,
      };

      if (opts.format === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      output.section(`Git Insights: ${relForGit}`);
      output.kv('Total commits', String(result.totalCommits));
      output.kv('Last touched', result.lastTouched ?? 'unknown');
      output.section(`Authors (${result.authors.length})`);
      for (const a of result.authors.slice(0, 8)) {
        output.kv(`  ${a.name}`, `${a.commits} commits (${a.share})`);
      }
      if (renames.length > 0) {
        output.section(`Rename/Refactor History (${renames.length})`);
        for (const r of renames.slice(-8)) {
          output.kv(`  ${r.commit}`, r.detail);
        }
      }
      output.section(`Recent Commits (${commits.length})`);
      for (const c of commits.slice(0, n)) {
        output.kv(`  ${c.hash} ${c.author}`, `${c.date?.slice(0, 10)} ${c.subject}`);
      }
    })
  );
}
