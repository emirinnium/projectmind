import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { assertProjectPath } from '../security/path-security.js';
import { reportSuppressedError } from '../../utils/errors.js';

export interface HistoryScoreOptions {
  nowMs?: number;
  cacheSize?: number;
}

interface HistoryAggregate {
  newestTimestamp: number;
  fixCount: number;
  commitCount: number;
}

const HISTORY_BATCH_SIZE = 64;

/**
 * Small, bounded Git history scorer used as a reranking signal. It never
 * invokes a shell and validates the source path before passing it to Git.
 * Missing Git history is represented by `undefined`, allowing the caller to
 * retain the neutral prior instead of treating new files as unstable.
 */
export class HistoryRanker {
  private readonly cache = new Map<string, number | undefined>();
  private readonly nowMs: number;
  private readonly cacheSize: number;

  constructor(
    private readonly projectRoot: string,
    options: HistoryScoreOptions = {},
  ) {
    this.nowMs = options.nowMs ?? Date.now();
    this.cacheSize = Math.max(1, options.cacheSize ?? 256);
  }

  score(filePath: string): number | undefined {
    const relativePath = this.normalizePath(filePath);
    if (!relativePath) return undefined;
    const cached = this.cache.get(relativePath);
    if (cached !== undefined || this.cache.has(relativePath)) return cached;

    const score = this.readScore(relativePath);
    this.remember(relativePath, score);
    return score;
  }

  /**
   * Resolve history for many files with bounded Git invocations. Calling
   * `score()` in a loop starts one process per file and becomes prohibitively
   * slow in large repositories. Each batch retains path-filtered Git
   * semantics and is capped at 64 paths for Windows command-line safety.
   */
  scoreMany(filePaths: readonly string[]): ReadonlyMap<string, number | undefined> {
    const normalized = [
      ...new Set(
        filePaths
          .map((filePath) => this.normalizePath(filePath))
          .filter((filePath): filePath is string => Boolean(filePath)),
      ),
    ];
    const scores = new Map<string, number | undefined>();
    for (const filePath of normalized) {
      if (this.cache.has(filePath)) scores.set(filePath, this.cache.get(filePath));
    }
    const pending = normalized.filter((filePath) => !this.cache.has(filePath));
    for (let offset = 0; offset < pending.length; offset += HISTORY_BATCH_SIZE) {
      const chunk = pending.slice(offset, offset + HISTORY_BATCH_SIZE);
      const aggregates = this.readScoresBatch(chunk);
      for (const filePath of chunk) {
        const score = this.scoreAggregate(aggregates.get(filePath));
        scores.set(filePath, score);
        this.remember(filePath, score);
      }
    }
    return scores;
  }

  private readScore(relativePath: string): number | undefined {
    return this.scoreAggregate(this.readScoresBatch([relativePath]).get(relativePath));
  }

  private readScoresBatch(relativePaths: readonly string[]): Map<string, HistoryAggregate> {
    const aggregates = new Map<string, HistoryAggregate>();
    try {
      const log = execFileSync(
        process.platform === 'win32' ? 'git.exe' : 'git',
        ['log', '-30', '--format=%ct%x00%s', '--name-only', '--', ...relativePaths],
        {
          cwd: resolve(this.projectRoot),
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const requested = new Set(relativePaths);
      let current: { timestamp: number; subject: string } | undefined;
      for (const rawLine of log.split(/\r?\n/)) {
        const header = rawLine.match(/^(\d+)\0(.*)$/);
        if (header) {
          const timestamp = Number(header[1]) * 1000;
          current =
            Number.isFinite(timestamp) && timestamp > 0
              ? { timestamp, subject: header[2] }
              : undefined;
          continue;
        }
        if (!current || rawLine.trim().length === 0) continue;
        const path = rawLine.replace(/\\/g, '/');
        if (!requested.has(path)) continue;
        const aggregate = aggregates.get(path) ?? {
          newestTimestamp: 0,
          fixCount: 0,
          commitCount: 0,
        };
        aggregate.newestTimestamp = Math.max(aggregate.newestTimestamp, current.timestamp);
        aggregate.commitCount++;
        if (/\b(?:fix|bug|security|hotfix|regression)\b/i.test(current.subject))
          aggregate.fixCount++;
        aggregates.set(path, aggregate);
      }
    } catch (error) {
      // Missing Git history is an explicit neutral-prior condition.
      reportSuppressedError(error, 'Git history ranking unavailable; using neutral prior');
    }
    return aggregates;
  }

  private scoreAggregate(aggregate: HistoryAggregate | undefined): number | undefined {
    if (!aggregate || aggregate.commitCount === 0 || aggregate.newestTimestamp === 0)
      return undefined;
    const ageDays = Math.max(0, this.nowMs - aggregate.newestTimestamp) / 86_400_000;
    const recency = Math.exp(-ageDays / 365);
    const stability = 1 - Math.min(1, aggregate.fixCount / aggregate.commitCount);
    return Math.min(1, Math.max(0, recency * 0.65 + stability * 0.35));
  }

  private normalizePath(filePath: string): string | undefined {
    try {
      const safePath = assertProjectPath(filePath, this.projectRoot, {
        mustExist: true,
        rejectIgnored: true,
      });
      return relative(resolve(this.projectRoot), safePath).replace(/\\/g, '/');
    } catch {
      return undefined;
    }
  }

  private remember(filePath: string, score: number | undefined): void {
    this.cache.set(filePath, score);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }
}
