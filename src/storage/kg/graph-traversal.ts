import { getAllFiles } from './helpers/index.js';
import type { KgContext } from './helpers/context.js';
import type { SQLOutputValue } from 'node:sqlite';
import { isTestPath } from '../../utils/test-detection.js';

export interface GraphNode {
  id: number;
  path: string;
  relativePath: string;
  language: string;
  cognitiveLoad: number;
  agentTouched: boolean;
  agentTouchedBy: string | null;
}

export interface GraphEdge {
  from: number; // file id
  to: number;   // file id
  type: 'imports' | 'imported-by' | 'calls' | 'tested-by' | 'extends' | 'implements';
  weight: number;
}

export interface TraversalResult {
  visited: GraphNode[];
  depth: number;
  path: string[]; // import path taken
}

export interface PathResult {
  found: boolean;
  path: string[];
  distance: number;
  hops: GraphNode[];
}

export interface PageRankResult {
  fileId: number;
  path: string;
  score: number;
  rank: number;
}

export interface Community {
  id: number;
  members: GraphNode[];
  density: number;
  internalEdges: number;
  externalEdges: number;
}

export interface Subgraph {
  center: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  radius: number;
}

/**
 * In-memory graph traversal engine for the knowledge graph.
 * Builds adjacency list from SQLite imports table, then provides
 * graph algorithms: BFS, shortest path, PageRank, community detection.
 */
export class GraphTraversal {
  private adjacencyList: Map<number, Set<number>> = new Map();
  private reverseAdjacency: Map<number, Set<number>> = new Map();
  private nodeMap: Map<number, GraphNode> = new Map();
  /** File ids that look like test/spec files (isTestPath). */
  private testFiles: Set<number> = new Set();
  private built = false;

  constructor(private ctx: KgContext) {}

  /**
   * Build the in-memory graph from the database.
   * Import edges originating FROM a test file are typed 'tested-by' —
   * they represent "this source file is exercised by this test".
   */
  build(): void {
    if (this.built) return;

    const files = getAllFiles(this.ctx);
    for (const f of files) {
      if (f.relativePath && isTestPath(f.relativePath)) this.testFiles.add(f.id);
      this.nodeMap.set(f.id, {
        id: f.id,
        path: f.path,
        relativePath: f.relativePath,
        language: f.language,
        cognitiveLoad: f.cognitiveLoad,
        agentTouched: f.agentTouched,
        agentTouchedBy: f.agentTouchedBy,
      });
      if (!this.adjacencyList.has(f.id)) {
        this.adjacencyList.set(f.id, new Set());
      }
      if (!this.reverseAdjacency.has(f.id)) {
        this.reverseAdjacency.set(f.id, new Set());
      }
    }

    // Build edges from imports table
    const importRows = this.ctx.db.prepare(`
      SELECT i.file_id, i.resolved_path, f2.id as target_id
      FROM imports i
      JOIN files f1 ON i.file_id = f1.id
      LEFT JOIN files f2 ON i.resolved_path = f2.relative_path AND f2.project_id = ?
      WHERE f1.project_id = ? AND f2.id IS NOT NULL
    `).all(this.ctx.currentProjectId, this.ctx.currentProjectId) as Record<string, SQLOutputValue>[];

    for (const row of importRows) {
      const fromId = row.file_id as number;
      const toId = row.target_id as number;
      if (this.adjacencyList.has(fromId) && this.nodeMap.has(toId)) {
        this.adjacencyList.get(fromId)!.add(toId);
        this.reverseAdjacency.get(toId)!.add(fromId);
      }
    }

    this.built = true;
  }

  /**
   * BFS traversal from a starting file.
   * forward=true follows this file's imports (its dependencies);
   * forward=false follows reverse edges (its dependents — the blast radius).
   */
  bfs(startFileId: number, maxDepth: number = 10, forward: boolean = true): TraversalResult {
    this.build();
    const graph = forward ? this.adjacencyList : this.reverseAdjacency;
    const visited: GraphNode[] = [];
    const visitedIds = new Set<number>();
    const queue: { id: number; depth: number; path: string[] }[] = [
      { id: startFileId, depth: 0, path: [] },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visitedIds.has(current.id) || current.depth > maxDepth) continue;
      visitedIds.add(current.id);

      const node = this.nodeMap.get(current.id);
      if (node) {
        visited.push(node);
      }

      const neighbors = graph.get(current.id);
      if (neighbors) {
        for (const neighborId of neighbors) {
          if (!visitedIds.has(neighborId)) {
            const neighborNode = this.nodeMap.get(neighborId);
            queue.push({
              id: neighborId,
              depth: current.depth + 1,
              path: [...current.path, neighborNode?.relativePath || ''],
            });
          }
        }
      }
    }

    return { visited, depth: maxDepth, path: [] };
  }

  /**
   * Shortest path between two files using BFS.
   */
  shortestPath(fromFileId: number, toFileId: number, maxDepth: number = 20): PathResult {
    this.build();
    const visited = new Set<number>();
    const parent = new Map<number, number>();
    const queue: number[] = [fromFileId];
    visited.add(fromFileId);

    let found = false;
    let depth = 0;

    while (queue.length > 0 && depth < maxDepth) {
      const levelSize = queue.length;
      for (let i = 0; i < levelSize; i++) {
        const current = queue.shift()!;
        if (current === toFileId) {
          found = true;
          break;
        }

        const neighbors = this.adjacencyList.get(current);
        if (neighbors) {
          for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
              visited.add(neighbor);
              parent.set(neighbor, current);
              queue.push(neighbor);
            }
          }
        }
      }
      if (found) break;
      depth++;
    }

    // Reconstruct path
    const path: string[] = [];
    const hops: GraphNode[] = [];
    if (found) {
      let current = toFileId;
      while (current !== fromFileId) {
        const node = this.nodeMap.get(current);
        if (node) {
          path.unshift(node.relativePath);
          hops.unshift(node);
        }
        current = parent.get(current)!;
      }
      const startNode = this.nodeMap.get(fromFileId);
      if (startNode) {
        path.unshift(startNode.relativePath);
        hops.unshift(startNode);
      }
    }

    return { found, path, distance: hops.length - 1, hops };
  }

  /**
   * PageRank algorithm — identifies most "important" files in the graph.
   * Files that are imported by many other files get higher rank.
   */
  pageRank(iterations: number = 20, damping: number = 0.85): PageRankResult[] {
    this.build();
    const nodes = Array.from(this.nodeMap.keys());
    const n = nodes.length;
    if (n === 0) return [];

    // Initialize scores
    const scores = new Map<number, number>();
    const outgoing = new Map<number, number>();

    for (const nodeId of nodes) {
      scores.set(nodeId, 1.0 / n);
      outgoing.set(nodeId, this.adjacencyList.get(nodeId)?.size || 0);
    }

    // Iterate
    for (let iter = 0; iter < iterations; iter++) {
      const newScores = new Map<number, number>();

      for (const nodeId of nodes) {
        let sum = 0;
        const inLinks = this.reverseAdjacency.get(nodeId);
        if (inLinks) {
          for (const inNode of inLinks) {
            const out = outgoing.get(inNode) || 1;
            sum += (scores.get(inNode) || 0) / out;
          }
        }
        newScores.set(nodeId, (1 - damping) / n + damping * sum);
      }

      // Update scores
      for (const nodeId of nodes) {
        scores.set(nodeId, newScores.get(nodeId) || 0);
      }
    }

    // Sort and rank
    const sorted = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([fileId, score], index) => ({
        fileId,
        path: this.nodeMap.get(fileId)?.relativePath || '',
        score,
        rank: index + 1,
      }));

    return sorted;
  }

  /**
   * Community detection using connected components (Union-Find).
   * Identifies modular clusters in the codebase.
   */
  detectCommunities(): Community[] {
    this.build();
    const parent = new Map<number, number>();
    const rank = new Map<number, number>();

    // Initialize Union-Find
    for (const nodeId of this.nodeMap.keys()) {
      parent.set(nodeId, nodeId);
      rank.set(nodeId, 0);
    }

    const find = (x: number): number => {
      if (parent.get(x) !== x) {
        parent.set(x, find(parent.get(x)!));
      }
      return parent.get(x)!;
    };

    const union = (x: number, y: number): void => {
      const px = find(x);
      const py = find(y);
      if (px === py) return;
      const rx = rank.get(px) || 0;
      const ry = rank.get(py) || 0;
      if (rx < ry) parent.set(px, py);
      else if (rx > ry) parent.set(py, px);
      else {
        parent.set(py, px);
        rank.set(px, rx + 1);
      }
    };

    // Union connected nodes
    for (const [fromId, neighbors] of this.adjacencyList) {
      for (const toId of neighbors) {
        union(fromId, toId);
      }
    }

    // Group by community
    const communityMap = new Map<number, number[]>();
    for (const nodeId of this.nodeMap.keys()) {
      const root = find(nodeId);
      if (!communityMap.has(root)) {
        communityMap.set(root, []);
      }
      communityMap.get(root)!.push(nodeId);
    }

    // Build Community objects
    const communities: Community[] = [];
    let communityId = 0;
    for (const [, memberIds] of communityMap) {
      const members: GraphNode[] = [];
      let internalEdges = 0;
      let externalEdges = 0;

      for (const id of memberIds) {
        const node = this.nodeMap.get(id);
        if (node) members.push(node);

        const neighbors = this.adjacencyList.get(id);
        if (neighbors) {
          for (const neighbor of neighbors) {
            if (memberIds.includes(neighbor)) {
              internalEdges++;
            } else {
              externalEdges++;
            }
          }
        }
      }

      const n = members.length;
      const maxEdges = n * (n - 1);
      const density = maxEdges > 0 ? internalEdges / maxEdges : 0;

      communities.push({
        id: communityId++,
        members,
        density,
        internalEdges,
        externalEdges,
      });
    }

    // Sort by size descending
    communities.sort((a, b) => b.members.length - a.members.length);
    return communities;
  }

  /**
   * Extract a subgraph centered on a file, up to N hops.
   */
  extractSubgraph(centerFileId: number, hops: number = 2): Subgraph {
    this.build();
    const center = this.nodeMap.get(centerFileId);
    if (!center) {
      return { center: { id: 0, path: '', relativePath: '', language: '', cognitiveLoad: 0, agentTouched: false, agentTouchedBy: null }, nodes: [], edges: [], radius: 0 };
    }

    const included = new Set<number>([centerFileId]);
    const edges: GraphEdge[] = [];

    // Expand in BOTH directions: a refactor's blast radius includes files
    // that IMPORT this file (dependents, reverse edges) at least as much as
    // the files it imports. Forward edges are typed 'imports', reverse
    // edges 'imported-by' so consumers can draw direction correctly.
    let frontier = new Set<number>([centerFileId]);
    for (let h = 0; h < hops; h++) {
      const nextFrontier = new Set<number>();
      for (const nodeId of frontier) {
        for (const neighborId of this.adjacencyList.get(nodeId) ?? []) {
          edges.push({ from: nodeId, to: neighborId, type: this.edgeTypeFor(nodeId), weight: 1 });
          if (!included.has(neighborId)) {
            included.add(neighborId);
            nextFrontier.add(neighborId);
          }
        }
        for (const neighborId of this.reverseAdjacency.get(nodeId) ?? []) {
          edges.push({ from: nodeId, to: neighborId, type: 'imported-by', weight: 1 });
          if (!included.has(neighborId)) {
            included.add(neighborId);
            nextFrontier.add(neighborId);
          }
        }
      }
      frontier = nextFrontier;
    }

    const nodes: GraphNode[] = [];
    for (const id of included) {
      const node = this.nodeMap.get(id);
      if (node) nodes.push(node);
    }

    return { center, nodes, edges, radius: hops };
  }

  /** Edge semantic: imports from a test file mean "tested-by". */
  private edgeTypeFor(fromId: number): GraphEdge['type'] {
    return this.testFiles.has(fromId) ? 'tested-by' : 'imports';
  }

  /**
   * Direct tests exercising a file = reverse-neighbors that are test files.
   */
  getTestsFor(fileId: number): GraphNode[] {
    this.build();
    const tests: GraphNode[] = [];
    for (const dependentId of this.reverseAdjacency.get(fileId) ?? []) {
      if (this.testFiles.has(dependentId)) {
        const node = this.nodeMap.get(dependentId);
        if (node) tests.push(node);
      }
    }
    return tests;
  }

  /**
   * Get impact radius — how many files are affected if this file changes.
   * Traverses REVERSE edges (dependents), not outgoing imports: changing a
   * leaf utility affects everyone who imports it even though it imports
   * nothing itself.
   */
  getImpactRadius(fileId: number): { direct: number; transitive: number; affected: GraphNode[] } {
    this.build();
    const directDependents = this.reverseAdjacency.get(fileId)?.size || 0;
    const bfsResult = this.bfs(fileId, 10, /* forward */ false);

    // Filter out the starting file
    const affected = bfsResult.visited.filter((n) => n.id !== fileId);
    return {
      direct: directDependents,
      transitive: affected.length,
      affected,
    };
  }

  /**
   * Get graph statistics.
   */
  getStats(): {
    totalNodes: number;
    totalEdges: number;
    avgDegree: number;
    maxDegree: number;
    density: number;
    connectedComponents: number;
  } {
    this.build();
    const totalNodes = this.nodeMap.size;
    let totalEdges = 0;
    let maxDegree = 0;

    for (const [, neighbors] of this.adjacencyList) {
      totalEdges += neighbors.size;
      if (neighbors.size > maxDegree) maxDegree = neighbors.size;
    }

    const communities = this.detectCommunities();
    const maxEdges = totalNodes * (totalNodes - 1);

    return {
      totalNodes,
      totalEdges,
      avgDegree: totalNodes > 0 ? totalEdges / totalNodes : 0,
      maxDegree,
      density: maxEdges > 0 ? totalEdges / maxEdges : 0,
      connectedComponents: communities.length,
    };
  }
}

// Convenience functions
export function createGraphTraversal(ctx: KgContext): GraphTraversal {
  const traversal = new GraphTraversal(ctx);
  traversal.build();
  return traversal;
}
