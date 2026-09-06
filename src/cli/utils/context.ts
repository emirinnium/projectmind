import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '@/utils/config.js';
import { initDatabase, closeDatabase } from '@/storage/database.js';
import { KnowledgeGraph } from '@/storage/kg/graph.js';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { globalCacheRegistry } from '@/core/cache/index.js';

export type ContextFn<T> = (ctx: CLIContext, service: T) => Promise<void>;

export interface CLIContext {
  config: ReturnType<typeof loadConfig>;
  db: DatabaseSync;
  kg: KnowledgeGraph;
}

export async function createContext(overrideRoot?: string): Promise<CLIContext> {
  const config = loadConfig();

  const projectRoot = overrideRoot || config.projectRoot;
  const databasePath = overrideRoot ? '.projectmind/pm-knowledge.db' : config.databasePath;

  const dbPath = join(projectRoot, databasePath);
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }
  const db = initDatabase(dbPath);
  const kg = new KnowledgeGraph(db);
  return { config: { ...config, projectRoot, databasePath }, db, kg };
}

export function closeContext(ctx: CLIContext): void {
  // Services such as DebtTracker may create persistent caches with interval
  // timers. Release them before closing the database so one-shot CLI commands
  // terminate cleanly and do not retain stale handles between invocations.
  globalCacheRegistry.destroyAll();
  if (ctx?.db) {
    closeDatabase();
  }
}
