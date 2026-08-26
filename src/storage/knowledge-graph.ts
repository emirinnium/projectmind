// Re-export from new modular location for backwards compatibility
export { KnowledgeGraph } from './kg/graph.js';
export type { FileInfo, MemoryEntry, AgentSession } from './kg/types.js';

// Graph traversal engine — real graph algorithms (BFS, PageRank, community detection)
export { GraphTraversal, createGraphTraversal } from './kg/graph-traversal.js';
export type {
  GraphNode,
  GraphEdge,
  TraversalResult,
  PathResult,
  PageRankResult,
  Community,
  Subgraph,
} from './kg/graph-traversal.js';
