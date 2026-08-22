/**
 * Repository pattern implementations for ProjectMind data access.
 * 
 * Each repository encapsulates database operations for a specific domain:
 * - {@link ProjectRepository} - Project CRUD operations
 * - {@link FileRepository} - File tracking and metadata
 * - {@link ImportRepository} - Import/dependency analysis
 * - {@link MemoryRepository} - Agent sessions and memory
 * - {@link DataFlowRepository} - Taint analysis data flows
 * - {@link DynamicCallRepository} - Runtime call tracing
 * 
 * All repositories accept an optional DatabaseSync instance for DI.
 * 
 * @example
 * ```typescript
 * // Using default singleton database
 * const fileRepo = new FileRepository();
 * 
 * // Using custom database (for testing)
 * const db = new DatabaseSync(':memory:');
 * const fileRepo = new FileRepository(db);
 * ```
 * 
 * @module storage/repositories
 */

// Repository barrel export
export { ProjectRepository } from './project-repository.js';
export type { Project } from './project-repository.js';

export { FileRepository } from './file-repository.js';
export type { FileRecord, FileAttributes } from './file-repository.js';

export { ImportRepository } from './import-repository.js';

export { MemoryRepository } from './memory-repository.js';
export type { MemoryEntry, AgentSession } from './memory-repository.js';

export { DataFlowRepository } from './data-flow-repository.js';
export type { Resource, DataFlowEntry, ResourceKind, DataFlowKind } from './data-flow-repository.js';

export { DynamicCallRepository } from './dynamic-call-repository.js';
export type { DynamicCall } from './dynamic-call-repository.js';
