// ProjectMind Root Barrel
// Main entry point — re-exports all public APIs organized by domain.
// See src/core/index.ts for core services, src/storage for storage,
// src/parser for AST operations, and other directories for specialized APIs.

// Core Services
export * from './core/index.js';

// Storage Layer
export * from './storage/index.js';

// Utilities
export * from './utils/index.js';

// Parser
export { 
  parseFile, 
  detectLanguage, 
  type Language, 
  type FileStructure, 
  type FunctionInfo, 
  type ClassInfo, 
  type ParameterInfo 
} from './parser/ast-parser.js';

// Embeddings
export { 
  cosineSimilarity, 
  codeToEmbedding, 
  textToEmbedding, 
  findSimilar, 
  type EmbeddingVector, 
  clearEmbeddingCache 
} from './parser/embeddings.js';

// Pattern Extractor
export { 
  PatternLibrary, 
  type Pattern, 
  type PatternViolation 
} from './parser/pattern-extractor.js';

// Structural Search
export {
  StructuralSearcher,
  type StructuralMatch,
  type StructuralSearchOptions,
  type StructuralReplaceOptions,
} from './parser/structural-search.js';

// MCP Server (for programmatic use)
export { initMcpServer, shutdownMcpServer } from './mcp-server.js';