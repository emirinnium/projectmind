/**
 * Test helper for creating KnowledgeGraph instances with dependency injection.
 * 
 * Provides factory functions for creating KnowledgeGraph instances with
 * optional dependency injection, using sensible defaults for testing.
 * 
 * @example
 * ```typescript
 * const { kg, db, cleanup } = createTestKnowledgeGraph();
 * // ... use kg ...
 * cleanup();
 * ```
 * 
 * @module test-helpers/knowledge-graph
 */

import { DatabaseSync } from 'node:sqlite';
import { KnowledgeGraph, KnowledgeGraphDeps } from '../storage/kg/graph.js';
import { createIsolatedDatabase } from './database.js';

/**
 * Result of creating a test KnowledgeGraph instance.
 */
export interface TestKnowledgeGraph {
  /** The KnowledgeGraph instance */
  kg: KnowledgeGraph;
  /** The underlying database instance */
  db: DatabaseSync;
  /** Cleanup function — call when done to close the database */
  cleanup: () => void;
}

/**
 * Create a KnowledgeGraph instance for testing with an isolated database.
 * 
 * Accepts optional dependencies for injection. If not provided, sensible
 * defaults are used (real fs/promises, real parser, real embeddings).
 * 
 * @param deps - Optional dependencies to inject into the KnowledgeGraph
 * @returns A test KnowledgeGraph instance with db and cleanup function
 */
export function createTestKnowledgeGraph(deps?: KnowledgeGraphDeps): TestKnowledgeGraph {
  const { db, cleanup } = createIsolatedDatabase();
  const kg = new KnowledgeGraph(db, deps);

  return {
    kg,
    db,
    cleanup,
  };
}
