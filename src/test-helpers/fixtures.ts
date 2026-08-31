/**
 * Test helper for fixture setup and teardown.
 * 
 * Provides helpers for setting up and tearing down test fixtures,
 * including database instances and KnowledgeGraph instances.
 * 
 * @example
 * ```typescript
 * const fixture = await setupFixture();
 * // ... use fixture.kg and fixture.db ...
 * await teardownFixture(fixture);
 * ```
 * 
 * @module test-helpers/fixtures
 */

import { KnowledgeGraphDeps } from '../storage/kg/graph.js';
import { createTestKnowledgeGraph, TestKnowledgeGraph } from './knowledge-graph.js';

/**
 * A test fixture containing a KnowledgeGraph and its database.
 */
export type Fixture = TestKnowledgeGraph;

/**
 * Set up a test fixture with an isolated KnowledgeGraph.
 * 
 * @param deps - Optional dependencies to inject into the KnowledgeGraph
 * @returns A fixture object with kg, db, and cleanup function
 */
export async function setupFixture(deps?: KnowledgeGraphDeps): Promise<Fixture> {
  return createTestKnowledgeGraph(deps);
}

/**
 * Tear down a test fixture, closing the database connection.
 * 
 * @param fixture - The fixture to tear down
 */
export async function teardownFixture(fixture: Fixture): Promise<void> {
  fixture.cleanup();
}
