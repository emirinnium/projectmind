/**
 * Database connection management for ProjectMind.
 * 
 * Provides two patterns:
 * 1. **Singleton** (default, backward-compatible) - via {@link initDatabase}, {@link getDatabase}
 * 2. **Dependency Injection** - via {@link DatabaseManager} class
 * 
 * Features:
 * - WAL mode for concurrent reads
 * - Statement caching for hot paths
 * - Nested transaction support via SAVEPOINT
 * - Automatic migration on startup
 * 
 * @example
 * ```typescript
 * // Singleton usage (existing code)
 * const db = initDatabase('./pm-knowledge.db');
 * 
 * // Dependency injection (new code)
 * const manager = new DatabaseManager('./test.db');
 * const db = manager.init();
 * manager.runInTransaction(() => { ... });
 * manager.close();
 * ```
 * 
 * @module storage/database
 */

import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from './database-core.js';
import { getStatement as getStatementFromCache } from './database-statements.js';

export { DatabaseManager } from './database-core.js';
export type { RetryOptions } from './database-utils.js';

export {
  initDatabase,
  getDatabase,
  setDatabase,
  closeDatabase,
  getSchemaVersion,
  runInTransaction,
  isInTransaction,
} from './database-core.js';

export { runWithRetry } from './database-utils.js';

/**
 * Fetch a cached prepared statement for the given SQL, creating and
 * storing it on first use. All callers share the same compiled object.
 */
export function getStatement(sql: string): ReturnType<DatabaseSync['prepare']> {
  return getStatementFromCache(sql, getDatabase());
}
