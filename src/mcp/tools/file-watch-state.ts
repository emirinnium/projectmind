import { watch, type FSWatcher } from 'node:fs';
import { relative } from 'node:path';
import { logger } from '../../utils/logger.js';
import { parseFile } from '../../parser/ast-parser.js';
import type { McpDependencies } from './types.js';

export const fileWatches = new Map<
  string,
  { agentId: string; callback?: string; registeredAt: string }[]
>();
const liveWatchers = new Map<string, FSWatcher>();
// Intentional stops must NOT reschedule: without this set the 'close'/'error'
// handlers resurrect every watcher ~5s after unregister_file_watch.
const intentionalStops = new Set<string>();
const pendingRestarts = new Map<string, NodeJS.Timeout>();

export function forgetRegisteredWatch(filePath: string, agentId: string): void {
  const watches = fileWatches.get(filePath);
  if (!watches) return;
  const remaining = watches.filter((watchEntry) => watchEntry.agentId !== agentId);
  if (remaining.length === 0) fileWatches.delete(filePath);
  else fileWatches.set(filePath, remaining);
}

function scheduleRestart(key: string, startWatcher: () => void): void {
  if (intentionalStops.has(key)) return;
  if (pendingRestarts.has(key)) return;
  pendingRestarts.set(
    key,
    setTimeout(() => {
      pendingRestarts.delete(key);
      startWatcher();
    }, 5000),
  );
}

export function startLiveWatch(deps: McpDependencies, filePath: string, agentId: string): void {
  const key = `${filePath}::${agentId}`;
  if (liveWatchers.has(key)) return;
  intentionalStops.delete(key);

  const startWatcher = () => {
    try {
      let activeWatcher: FSWatcher | null = null;
      const w = watch(filePath, { persistent: false }, (eventType) => {
        if (eventType === 'rename') {
          // A file-level watcher cannot reliably follow an inode after an
          // unlink/rename. Stop this registration and remove the stale graph
          // row; callers can register again after recreating the file.
          intentionalStops.add(key);
          const rel = relative(deps.projectRoot, filePath).replace(/\\/g, '/');
          try {
            const removed = deps.kg.removeFile?.(rel) ?? false;
            if (removed) logger.info(`Removed deleted watched file ${rel} from the graph.`);
          } catch (error) {
            logger.warn(`Failed to remove deleted watched file ${rel} from the graph:`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          forgetRegisteredWatch(filePath, agentId);
          activeWatcher?.close();
          liveWatchers.delete(key);
          return;
        }
        if (eventType !== 'change') return;
        void deps.kg.markAgentTouched(filePath, agentId).catch((error) => {
          logger.warn(`Watcher could not mark ${filePath} as agent-touched:`, {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        // Incremental single-file refresh: re-parse and upsert so functions,
        // classes, dependents, and the configured file embedding in the KG
        // stay current without a full scan_project.
        try {
          const struct = parseFile(filePath);
          if (struct) {
            const rel = relative(deps.projectRoot, filePath).replace(/\\/g, '/');
            void Promise.resolve(deps.kg.upsertFile(struct, rel))
              .then((fileId) => deps.kg.storeFileDetails(fileId, struct))
              .catch((error) => {
                logger.warn(`Watcher KG upsert failed for ${rel}:`, {
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          }
        } catch (error) {
          logger.warn(`Watcher refresh failed for ${filePath}:`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      activeWatcher = w;

      w.on('error', (error) => {
        logger.warn(`Watcher error for ${filePath}:`, {
          error: error instanceof Error ? error.message : String(error),
        });
        liveWatchers.delete(key);
        if (!intentionalStops.has(key)) scheduleRestart(key, startWatcher);
      });

      w.on('close', () => {
        liveWatchers.delete(key);
        if (intentionalStops.has(key)) {
          intentionalStops.delete(key);
          return;
        }
        scheduleRestart(key, startWatcher);
      });

      liveWatchers.set(key, w);
      logger.info(`Started watching ${filePath} for agent ${agentId}`);
    } catch (error) {
      logger.warn(`Failed to start watcher for ${filePath}:`, {
        error: error instanceof Error ? error.message : String(error),
      });
      scheduleRestart(key, startWatcher);
    }
  };

  startWatcher();
}

export function stopLiveWatch(filePath: string, agentId: string): void {
  const key = `${filePath}::${agentId}`;
  intentionalStops.add(key);
  const pending = pendingRestarts.get(key);
  if (pending) {
    clearTimeout(pending);
    pendingRestarts.delete(key);
  }
  liveWatchers.get(key)?.close();
  liveWatchers.delete(key);
}

export function closeAllLiveWatchers(): void {
  for (const [key, w] of liveWatchers) {
    intentionalStops.add(key);
    w.close();
  }
  for (const [, t] of pendingRestarts) clearTimeout(t);
  pendingRestarts.clear();
  liveWatchers.clear();
}

export function liveWatcherStats(): { active: number; pendingRestarts: number } {
  return { active: liveWatchers.size, pendingRestarts: pendingRestarts.size };
}

export function hasLiveWatch(filePath: string, agentId: string): boolean {
  return liveWatchers.has(`${filePath}::${agentId}`);
}
