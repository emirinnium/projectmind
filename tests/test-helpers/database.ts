/**
 * Test helper for creating isolated database instances.
 *
 * Provides disposable database instances for tests without touching
 * the global singleton via setDatabase() or initDatabase().
 *
 * Uses DatabaseManager for true isolation — each call creates a fresh
 * in-memory database bound to its own instance, so concurrent tests
 * never share state through a module-level singleton.
 *
 * The cleanup function also resets the cached singletons that the
 * KnowledgeGraph helpers read through (alias resolver, import-resolution
 * cache, and the global cache registry). Without this, a test that
 * triggers lazy initialization of those singletons would leak the
 * reference into the next test that calls createIsolatedDatabase().
 *
 * @example
 * ```typescript
 * const { db, cleanup } = createIsolatedDatabase();
 * const kg = new KnowledgeGraph(db);
 * // ... use db and kg ...
 * cleanup();
 * ```
 *
 * @module test-helpers/database
 */

import { DatabaseSync } from 'node:sqlite';
import { DatabaseManager } from '../../src/storage/database-core.js';
import { resetDefaultAliasResolver } from '../../src/parser/alias-resolver.js';
import { resetDefaultImportResolutionCache } from '../../src/core/cache/import-resolution-cache.js';
import { globalCacheRegistry } from '../../src/core/cache/index.js';

/**
 * Result of creating an isolated database instance.
 */
export interface IsolatedDatabase {
  /** The isolated database instance */
  db: DatabaseSync;
  /** Cleanup function — call when done to close the database */
  cleanup: () => void;
}

/**
 * Create a fresh in-memory database with schema and migrations applied.
 *
 * This uses DatabaseManager (dependency injection) rather than the global
 * singleton initDatabase(), so each returned `db` is fully independent:
 * concurrent tests, parallel vitest workers, or nested suites cannot see
 * each other's data.
 *
 * @returns An isolated database instance with a cleanup function
 */
export function createIsolatedDatabase(): IsolatedDatabase {
  const manager = new DatabaseManager(':memory:');
  const db = manager.init();

  return {
    db,
    cleanup: () => {
      manager.close();
      // Reset lazily-initialized singletons so the next test starts clean.
      resetDefaultAliasResolver();
      resetDefaultImportResolutionCache();
      globalCacheRegistry.clearAll();
    },
  };
}
