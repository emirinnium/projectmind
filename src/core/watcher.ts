import { watch as fsWatch, type Dirent, type FSWatcher } from 'node:fs';
import { readdir, stat, readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { loadConfig } from '../utils/config.js';
import { parseFile, type FileStructure } from '../parser/ast-parser.js';
import { logger } from '../utils/logger.js';
import { canonicalPath } from '../utils/paths.js';
import { getProjectIgnorePatterns, isIgnoredRelativePath } from '../utils/ignore.js';

/**
 * Incremental project watcher.
 *
 * Keeps the knowledge graph warm between scans: file change events are
 * debounced into batches, each changed file is re-parsed individually and
 * upserted into the KG (single-file refresh, no full rescan). Coherence
 * cache entries for touched files are invalidated so the next
 * check_coherence call analyzes fresh content.
 *
 * Scope: process-local daemon. Stop with stop() (or Ctrl+C in `pm watch`).
 */

/** Extensions with a registered parser (mirrors scanner's fast-glob set). */
const SUPPORTED_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export interface WatcherBatchResult {
  updated: string[];
  removed: string[];
  failed: string[];
}

export interface ProjectWatcherOptions {
  /** Root to watch; defaults to the configured project root. */
  root?: string;
  /** Settle window: events are batched until this many ms of quiet. Default 400. */
  debounceMs?: number;
  /** Called after each processed batch (even when empty of updates). */
  onBatchProcessed?: (result: WatcherBatchResult) => void;
  /** Also invalidate coherence cache for updated files. Requires engine. */
  coherence?: { invalidateFileCache(filePath: string): number } | null;
}

export interface WatcherStats {
  startedAt: number;
  eventsSeen: number;
  batchesProcessed: number;
  filesUpdated: number;
  filesRemoved: number;
  filesFailed: number;
  lastFileUpdatedAt: number | null;
}

export class ProjectWatcher {
  private recursiveWatcher: FSWatcher | null = null;
  private dirWatchers = new Map<string, FSWatcher>();
  private running = false;
  private pending = new Map<string, number>(); // absolute path -> first queued ts
  private timer: NodeJS.Timeout | null = null;
  private root = '';
  private ignorePatterns: string[] = [];
  private readonly debounceMs: number;
  private stats: WatcherStats = {
    startedAt: 0,
    eventsSeen: 0,
    batchesProcessed: 0,
    filesUpdated: 0,
    filesRemoved: 0,
    filesFailed: 0,
    lastFileUpdatedAt: null,
  };

  constructor(
    private kg: {
      upsertFile(struct: FileStructure, relPath: string): Promise<number>;
      storeFileDetails(fileId: number, struct: FileStructure): Promise<void> | void;
      removeFile?: (relPath: string) => Promise<boolean> | boolean;
    },
    private options: ProjectWatcherOptions = {},
  ) {
    this.debounceMs = Math.max(50, options.debounceMs ?? 400);
  }

  get watchedRoot(): string {
    return this.root;
  }

  getStats(): WatcherStats {
    return { ...this.stats };
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return; // already running
    this.root = resolve(this.options.root ?? loadConfig().projectRoot);
    this.ignorePatterns = getProjectIgnorePatterns(this.root);
    this.stats.startedAt = Date.now();

    try {
      this.recursiveWatcher = fsWatch(this.root, { recursive: true }, (_e, filename) => {
        this.handleFsEvent(filename, this.root);
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
        // Linux: recursive fs.watch is unavailable — fall back to a
        // dependency-free per-directory watcher walk.
        this.recursiveWatcher = null;
        void this.watchTree(this.root);
      } else {
        throw e;
      }
    }
    this.running = true;

    logger.info(`ProjectWatcher watching ${this.root} (debounce ${this.debounceMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.recursiveWatcher) {
      this.recursiveWatcher.close();
      this.recursiveWatcher = null;
    }
    for (const [, w] of this.dirWatchers) w.close();
    this.dirWatchers.clear();
    if (this.running) {
      this.running = false;
      logger.info('ProjectWatcher stopped.');
    }
    this.pending.clear();
  }

  private handleFsEvent(filename: string | Buffer | null, baseDir: string): void {
    this.stats.eventsSeen++;
    if (!filename) return;
    const abs = resolve(baseDir, filename.toString());
    if (!this.isTrackable(abs)) return;
    // Map stores latest occurrence; the timer handles coalescing.
    if (!this.pending.has(abs)) this.pending.set(abs, Date.now());
    this.scheduleFlush();
  }

  private async watchTree(dir: string): Promise<void> {
    this.watchDirectory(dir);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      // Directory unreadable (permissions or deleted) — skip subtree.
      logger.warn('Failed to read directory for watcher tree walk, skipping subtree', {
        dir,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = resolve(dir, entry.name);
      const childRel = relative(this.root, child).replace(/\\/g, '/') + '/';
      if (isIgnoredRelativePath(childRel, this.ignorePatterns)) continue;
      await this.watchTree(child);
    }
  }

  private watchDirectory(d: string): void {
    if (this.dirWatchers.has(d)) return;
    const w = fsWatch(d, (eventType, filename) => {
      this.handleFsEvent(filename, d);
      if (eventType === 'rename' && filename) {
        void this.reconcileRenamed(resolve(d, filename.toString()));
      }
    });
    w.on('error', (error) => {
      logger.warn(`Directory watcher error for ${d}:`, {
        error: error instanceof Error ? error.message : String(error),
      });
      w.close();
      this.dirWatchers.delete(d);
    });
    this.dirWatchers.set(d, w);
  }

  private async reconcileRenamed(abs: string): Promise<void> {
    try {
      if ((await stat(abs)).isDirectory()) await this.watchTree(abs);
    } catch (e) {
      // deleted path — its watcher (if any) cleans itself up on error
      logger.warn('Failed to stat renamed path in watcher, assuming deleted', {
        path: abs,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** True when the path should trigger a single-file re-index. */
  isTrackable(absPath: boolean | string | null): boolean {
    if (typeof absPath !== 'string') return false;
    if (!SUPPORTED_EXT.has(extname(absPath).toLowerCase())) return false;
    const rel = relative(this.root, absPath);
    if (rel.startsWith('..')) return false;
    return !isIgnoredRelativePath(rel, this.ignorePatterns);
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (this.pending.size === 0) return;

    const batch = [...this.pending.keys()];
    this.pending.clear();
    this.stats.batchesProcessed++;

    const updated: string[] = [];
    const removed: string[] = [];
    const failed: string[] = [];

    for (const abs of batch) {
      const rel = canonicalPath(relative(this.root, abs));
      try {
        // File I/O is asynchronous so a slow disk cannot block event delivery.
        let content: string;
        try {
          content = await readFile(abs, 'utf-8');
        } catch (error) {
          if (!isMissingPathError(error)) throw error;
          const removedFromGraph = this.kg.removeFile ? await this.kg.removeFile(rel) : false;
          if (removedFromGraph) removed.push(rel);
          else failed.push(rel);
          continue;
        }
        const struct = parseFile(abs, content);
        if (!struct) {
          // A live file that cannot be parsed must not delete its last known
          // graph state; report it for a future successful refresh instead.
          failed.push(rel);
          continue;
        }
        const fileId = await this.kg.upsertFile(struct, rel);
        await this.kg.storeFileDetails(fileId, struct);
        this.options.coherence?.invalidateFileCache(rel);
        updated.push(rel);
      } catch (e) {
        logger.warn(`Watcher failed to index ${abs}:`, {
          error: e instanceof Error ? e.message : String(e),
        });
        failed.push(canonicalPath(relative(this.root, abs)));
      }
    }

    this.stats.filesUpdated += updated.length;
    this.stats.filesRemoved += removed.length;
    this.stats.filesFailed += failed.length;
    if (updated.length > 0 || removed.length > 0) this.stats.lastFileUpdatedAt = Date.now();

    try {
      this.options.onBatchProcessed?.({ updated, removed, failed });
    } catch (error) {
      // consumer callback errors must not kill the watch loop
      logger.warn('Watcher onBatchProcessed callback failed:', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
