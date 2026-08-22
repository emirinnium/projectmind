// Unified Storage Layer Barrel
// Re-exports all storage modules for convenient importing

// Database
export { 
  initDatabase, 
  getDatabase, 
  setDatabase, 
  closeDatabase, 
  runInTransaction, 
  getStatement,
  runWithRetry,
  type RetryOptions as DatabaseRetryOptions 
} from './database.js';

// Schema
export { SCHEMA_SQL } from './schema.js';

// Knowledge Graph
export { KnowledgeGraph } from './kg/graph.js';
export type { FileInfo, MemoryEntry, AgentSession } from './kg/types.js';