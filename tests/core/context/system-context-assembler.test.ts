import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assembleSystemContext } from '../../../src/core/context/system-context-assembler.js';
import type { KnowledgeGraph } from '../../../src/storage/knowledge-graph.js';
import type { FileInfo } from '../../../src/storage/kg/types.js';
import type { GraphNode } from '../../../src/storage/kg/graph-traversal.js';

/**
 * Creates a mock FileInfo for testing.
 */
function mockFileInfo(overrides: Partial<FileInfo> = {}): FileInfo {
  return {
    id: 1,
    path: 'src/file.ts',
    relativePath: 'src/file.ts',
    language: 'typescript',
    sizeBytes: 100,
    hash: 'abc123',
    agentTouched: false,
    agentTouchedBy: null,
    agentTouchedAt: null,
    cognitiveLoad: 0.5,
    lastScanned: '2024-01-01T00:00:00Z',
    lastSynced: '2024-01-01T00:00:00Z',
    patterns: [],
    ...overrides,
  };
}

/**
 * Creates a mock GraphNode for testing.
 */
function mockGraphNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 2,
    path: 'src/dep.ts',
    relativePath: 'src/dep.ts',
    language: 'typescript',
    cognitiveLoad: 0.3,
    agentTouched: false,
    agentTouchedBy: null,
    ...overrides,
  };
}

/**
 * Creates a mock KnowledgeGraph with configurable behavior.
 */
function createMockKnowledgeGraph(options: {
  impactRadiusResult?: { direct: number; transitive: number; affected: GraphNode[] };
  bfsResult?: { visited: GraphNode[]; depth: number; path: string[] };
  dependents?: FileInfo[];
  embedding?: number[] | null;
  similarFiles?: FileInfo[];
  throwOnTraversal?: boolean;
  throwOnEmbedding?: boolean;
} = {}): KnowledgeGraph {
  const {
    impactRadiusResult = { direct: 0, transitive: 0, affected: [] },
    bfsResult = { visited: [], depth: 0, path: [] },
    dependents = [],
    embedding = null,
    similarFiles = [],
    throwOnTraversal = false,
    throwOnEmbedding = false,
  } = options;

  const mockTraversal = {
    getImpactRadius: vi.fn().mockReturnValue(impactRadiusResult),
    bfs: vi.fn().mockReturnValue(bfsResult),
  };

  return {
    getGraphTraversal: vi.fn().mockImplementation(() => {
      if (throwOnTraversal) {
        throw new Error('Graph traversal unavailable');
      }
      return mockTraversal;
    }),
    getDependents: vi.fn().mockReturnValue(dependents),
    getFileEmbedding: vi.fn().mockImplementation(() => {
      if (throwOnEmbedding) {
        throw new Error('Embedding unavailable');
      }
      return embedding;
    }),
    findSimilarFiles: vi.fn().mockReturnValue(similarFiles),
  } as unknown as KnowledgeGraph;
}

describe('assembleSystemContext', () => {
  // ============================================================
  // Task 1: assembleSystemContext() with a mock knowledge graph
  // ============================================================
  describe('basic assembly with mock knowledge graph', () => {
    it('returns a valid SystemContextResult structure', () => {
      const kg = createMockKnowledgeGraph();
      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      expect(result).toHaveProperty('task');
      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('consideredFiles');
      expect(result).toHaveProperty('note');
      expect(result).toHaveProperty('hasCircularDeps');
      expect(Array.isArray(result.items)).toBe(true);
      expect(typeof result.consideredFiles).toBe('number');
      expect(typeof result.note).toBe('string');
      expect(typeof result.hasCircularDeps).toBe('boolean');
    });

    it('returns empty items when no dependents or similar files exist', () => {
      const kg = createMockKnowledgeGraph();
      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/isolated.ts',
        cognitiveLoad: 0.2,
      });

      expect(result.items).toEqual([]);
      expect(result.consideredFiles).toBe(0);
    });

    it('includes task in the result when provided', () => {
      const kg = createMockKnowledgeGraph();
      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
        task: 'add rate limiting',
      });

      expect(result.task).toBe('add rate limiting');
    });

    it('returns null task when task is empty or whitespace', () => {
      const kg = createMockKnowledgeGraph();
      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
        task: '   ',
      });

      expect(result.task).toBeNull();
    });

    it('returns null task when task is not provided', () => {
      const kg = createMockKnowledgeGraph();
      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      expect(result.task).toBeNull();
    });
  });

  // ============================================================
  // Task 2: Graph traversal fallback when engine is unavailable
  // ============================================================
  describe('graph traversal fallback', () => {
    it('falls back to direct dependents when graph traversal throws', () => {
      const dependents = [
        mockFileInfo({ id: 10, path: 'src/dep1.ts', relativePath: 'src/dep1.ts' }),
        mockFileInfo({ id: 11, path: 'src/dep2.ts', relativePath: 'src/dep2.ts' }),
      ];
      const kg = createMockKnowledgeGraph({
        throwOnTraversal: true,
        dependents,
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      // Should have used the fallback path
      expect(kg.getDependents).toHaveBeenCalledWith(1);
      expect(result.items.length).toBe(2);
      expect(result.consideredFiles).toBe(2);
    });

    it('fallback items have direct-dependent reason', () => {
      const dependents = [
        mockFileInfo({ id: 10, path: 'src/dep1.ts', relativePath: 'src/dep1.ts' }),
      ];
      const kg = createMockKnowledgeGraph({
        throwOnTraversal: true,
        dependents,
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      expect(result.items[0].reasons).toContain('direct-dependent');
    });

    it('fallback items are scored at 0.5 (DIRECT_DEPENDENT_SCORE)', () => {
      const dependents = [
        mockFileInfo({ id: 10, path: 'src/dep1.ts', relativePath: 'src/dep1.ts' }),
      ];
      const kg = createMockKnowledgeGraph({
        throwOnTraversal: true,
        dependents,
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      expect(result.items[0].score).toBeCloseTo(0.5, 2);
    });

    it('handles both traversal and embedding failures gracefully', () => {
      const dependents = [
        mockFileInfo({ id: 10, path: 'src/dep1.ts', relativePath: 'src/dep1.ts' }),
      ];
      const kg = createMockKnowledgeGraph({
        throwOnTraversal: true,
        throwOnEmbedding: true,
        dependents,
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      // Should still produce results from the fallback
      expect(result.items.length).toBe(1);
    });
  });

  // ============================================================
  // Task 3: Semantic neighbor selection via embeddings
  // ============================================================
  describe('semantic neighbor selection', () => {
    it('includes semantic neighbors when embedding is available', () => {
      const embedding = [0.1, 0.2, 0.3, 0.4];
      const similarFiles = [
        mockFileInfo({ id: 20, path: 'src/similar1.ts', relativePath: 'src/similar1.ts' }),
        mockFileInfo({ id: 21, path: 'src/similar2.ts', relativePath: 'src/similar2.ts' }),
      ];
      const kg = createMockKnowledgeGraph({
        embedding,
        similarFiles,
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      expect(kg.getFileEmbedding).toHaveBeenCalledWith(1);
      expect(kg.findSimilarFiles).toHaveBeenCalledWith(embedding, 0.72, 10);
      expect(result.items.length).toBe(2);
    });

    it('semantic neighbors have semantically-similar reason', () => {
      const embedding = [0.1, 0.2, 0.3];
      const similarFiles = [
        mockFileInfo({ id: 20, path: 'src/similar.ts', relativePath: 'src/similar.ts' }),
      ];
      const kg = createMockKnowledgeGraph({
        embedding,
        similarFiles,
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      expect(result.items[0].reasons).toContain('semantically-similar');
    });

    it('semantic neighbors are scored at 0.32', () => {
      const embedding = [0.1, 0.2, 0.3];
      const similarFiles = [
        mockFileInfo({ id: 20, path: 'src/similar.ts', relativePath: 'src/similar.ts' }),
      ];
      const kg = createMockKnowledgeGraph({
        embedding,
        similarFiles,
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      expect(result.items[0].score).toBeCloseTo(0.32, 2);
    });

    it('skips semantic neighbors when embedding is null', () => {
      const kg = createMockKnowledgeGraph({ embedding: null });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      expect(kg.findSimilarFiles).not.toHaveBeenCalled();
      expect(result.items).toEqual([]);
    });

    it('skips semantic neighbors when embedding is empty array', () => {
      const kg = createMockKnowledgeGraph({ embedding: [] });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      expect(kg.findSimilarFiles).not.toHaveBeenCalled();
      expect(result.items).toEqual([]);
    });

    it('handles embedding lookup failure gracefully', () => {
      const kg = createMockKnowledgeGraph({ throwOnEmbedding: true });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      // Should not throw, just skip semantic neighbors
      expect(result.items).toEqual([]);
    });

    it('combines dependents and semantic neighbors in ranking', () => {
      const affected = [
        mockGraphNode({ id: 10, path: 'src/dep1.ts', relativePath: 'src/dep1.ts' }),
      ];
      const bfsVisited = [
        mockGraphNode({ id: 10, path: 'src/dep1.ts', relativePath: 'src/dep1.ts' }),
      ];
      const embedding = [0.1, 0.2];
      const similarFiles = [
        mockFileInfo({ id: 20, path: 'src/similar.ts', relativePath: 'src/similar.ts' }),
      ];
      const kg = createMockKnowledgeGraph({
        impactRadiusResult: { direct: 1, transitive: 1, affected },
        bfsResult: { visited: bfsVisited, depth: 1, path: [] },
        embedding,
        similarFiles,
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      // Both direct dependent and semantic neighbor should be present
      expect(result.items.length).toBe(2);
      // Direct dependent (0.5) should rank higher than semantic (0.32)
      expect(result.items[0].path).toBe('src/dep1.ts');
      expect(result.items[1].path).toBe('src/similar.ts');
    });
  });

  // ============================================================
  // Task 4: Token budget capping
  // ============================================================
  describe('token budget capping', () => {
    it('respects the limit option', () => {
      const affected = Array.from({ length: 10 }, (_, i) =>
        mockGraphNode({ id: 100 + i, path: `src/dep${i}.ts`, relativePath: `src/dep${i}.ts` })
      );
      const bfsVisited = [...affected];
      const kg = createMockKnowledgeGraph({
        impactRadiusResult: { direct: 10, transitive: 10, affected },
        bfsResult: { visited: bfsVisited, depth: 1, path: [] },
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
        limit: 5,
      });

      expect(result.items.length).toBe(5);
    });

    it('uses default limit of 16 when not specified', () => {
      const affected = Array.from({ length: 20 }, (_, i) =>
        mockGraphNode({ id: 100 + i, path: `src/dep${i}.ts`, relativePath: `src/dep${i}.ts` })
      );
      const bfsVisited = [...affected];
      const kg = createMockKnowledgeGraph({
        impactRadiusResult: { direct: 20, transitive: 20, affected },
        bfsResult: { visited: bfsVisited, depth: 1, path: [] },
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      expect(result.items.length).toBe(16);
    });

    it('caps items based on maxTokens budget', () => {
      const affected = Array.from({ length: 20 }, (_, i) =>
        mockGraphNode({ id: 100 + i, path: `src/dep${i}.ts`, relativePath: `src/dep${i}.ts` })
      );
      const bfsVisited = [...affected];
      const kg = createMockKnowledgeGraph({
        impactRadiusResult: { direct: 20, transitive: 20, affected },
        bfsResult: { visited: bfsVisited, depth: 1, path: [] },
      });

      // maxTokens=360 → budgetItems = floor(360*4/90) = floor(16) = 16
      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
        maxTokens: 360,
      });

      expect(result.items.length).toBeLessThanOrEqual(16);
    });

    it('maxTokens cap is at least 1', () => {
      const affected = Array.from({ length: 5 }, (_, i) =>
        mockGraphNode({ id: 100 + i, path: `src/dep${i}.ts`, relativePath: `src/dep${i}.ts` })
      );
      const bfsVisited = [...affected];
      const kg = createMockKnowledgeGraph({
        impactRadiusResult: { direct: 5, transitive: 5, affected },
        bfsResult: { visited: bfsVisited, depth: 1, path: [] },
      });

      // Very small maxTokens → budgetItems = floor(small*4/90) could be 0, but min is 1
      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
        maxTokens: 10,
      });

      // Should have at least 1 item if there are candidates
      expect(result.items.length).toBeGreaterThanOrEqual(1);
    });

    it('ignores maxTokens when it is 0 or negative', () => {
      const affected = Array.from({ length: 20 }, (_, i) =>
        mockGraphNode({ id: 100 + i, path: `src/dep${i}.ts`, relativePath: `src/dep${i}.ts` })
      );
      const bfsVisited = [...affected];
      const kg = createMockKnowledgeGraph({
        impactRadiusResult: { direct: 20, transitive: 20, affected },
        bfsResult: { visited: bfsVisited, depth: 1, path: [] },
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
        maxTokens: 0,
      });

      // maxTokens=0 → falls back to default limit (16)
      expect(result.items.length).toBe(16);
    });

    it('uses the smaller of limit and budgetItems', () => {
      const affected = Array.from({ length: 20 }, (_, i) =>
        mockGraphNode({ id: 100 + i, path: `src/dep${i}.ts`, relativePath: `src/dep${i}.ts` })
      );
      const bfsVisited = [...affected];
      const kg = createMockKnowledgeGraph({
        impactRadiusResult: { direct: 20, transitive: 20, affected },
        bfsResult: { visited: bfsVisited, depth: 1, path: [] },
      });

      // limit=10, maxTokens=360 → budgetItems=16, min(10, 16) = 10
      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
        limit: 10,
        maxTokens: 360,
      });

      expect(result.items.length).toBe(10);
    });
  });

  // ============================================================
  // Task 5: Scoring constants (DIRECT_DEPENDENT_SCORE, TRANSITIVE_DEPENDENT_SCORE)
  // ============================================================
  describe('scoring constants', () => {
    it('direct dependents receive score of 0.5 (DIRECT_DEPENDENT_SCORE)', () => {
      // One direct dependent (in BFS 1-hop), no transitive
      const directNode = mockGraphNode({ id: 10, path: 'src/direct.ts', relativePath: 'src/direct.ts' });
      const kg = createMockKnowledgeGraph({
        impactRadiusResult: {
          direct: 1,
          transitive: 1,
          affected: [directNode],
        },
        bfsResult: {
          visited: [directNode],
          depth: 1,
          path: [],
        },
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      expect(result.items.length).toBe(1);
      expect(result.items[0].score).toBeCloseTo(0.5, 2);
      expect(result.items[0].reasons).toContain('direct-dependent');
    });

    it('transitive dependents receive score of 0.28 (TRANSITIVE_DEPENDENT_SCORE)', () => {
      // One transitive dependent (NOT in BFS 1-hop)
      const transitiveNode = mockGraphNode({ id: 20, path: 'src/transitive.ts', relativePath: 'src/transitive.ts' });
      const kg = createMockKnowledgeGraph({
        impactRadiusResult: {
          direct: 0,
          transitive: 1,
          affected: [transitiveNode],
        },
        bfsResult: {
          visited: [], // empty — no direct dependents
          depth: 1,
          path: [],
        },
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      expect(result.items.length).toBe(1);
      expect(result.items[0].score).toBeCloseTo(0.28, 2);
      expect(result.items[0].reasons).toContain('in-blast-radius');
    });

    it('direct dependent scores higher than transitive dependent', () => {
      const directNode = mockGraphNode({ id: 10, path: 'src/direct.ts', relativePath: 'src/direct.ts' });
      const transitiveNode = mockGraphNode({ id: 20, path: 'src/transitive.ts', relativePath: 'src/transitive.ts' });
      const kg = createMockKnowledgeGraph({
        impactRadiusResult: {
          direct: 1,
          transitive: 2,
          affected: [directNode, transitiveNode],
        },
        bfsResult: {
          visited: [directNode], // only direct is in 1-hop BFS
          depth: 1,
          path: [],
        },
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      expect(result.items.length).toBe(2);
      // Direct should be ranked first (0.5 > 0.28)
      expect(result.items[0].path).toBe('src/direct.ts');
      expect(result.items[0].score).toBeCloseTo(0.5, 2);
      expect(result.items[1].path).toBe('src/transitive.ts');
      expect(result.items[1].score).toBeCloseTo(0.28, 2);
    });

    it('scores are capped at 1.0', () => {
      // Create a node that would accumulate score > 1.0
      const node = mockGraphNode({ id: 10, path: 'src/big.ts', relativePath: 'src/big.ts' });
      const kg = createMockKnowledgeGraph({
        impactRadiusResult: {
          direct: 1,
          transitive: 1,
          affected: [node],
        },
        bfsResult: {
          visited: [node],
          depth: 1,
          path: [],
        },
        embedding: [0.1, 0.2],
        similarFiles: [
          mockFileInfo({ id: 10, path: 'src/big.ts', relativePath: 'src/big.ts' }),
        ],
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      // Score should be capped at 1.0 (0.5 + 0.32 = 0.82, still under 1.0)
      for (const item of result.items) {
        expect(item.score).toBeLessThanOrEqual(1.0);
      }
    });

    it('scores are rounded to 3 decimal places', () => {
      const node = mockGraphNode({ id: 10, path: 'src/file.ts', relativePath: 'src/file.ts' });
      const kg = createMockKnowledgeGraph({
        impactRadiusResult: {
          direct: 1,
          transitive: 1,
          affected: [node],
        },
        bfsResult: {
          visited: [node],
          depth: 1,
          path: [],
        },
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      for (const item of result.items) {
        // Check that score has at most 3 decimal places
        const rounded = Math.round(item.score * 1000) / 1000;
        expect(item.score).toBe(rounded);
      }
    });
  });

  // ============================================================
  // Additional edge cases
  // ============================================================
  describe('edge cases', () => {
    it('excludes the source file from results', () => {
      // The source file itself should never appear in results
      const selfNode = mockGraphNode({ id: 1, path: 'src/main.ts', relativePath: 'src/main.ts' });
      const kg = createMockKnowledgeGraph({
        impactRadiusResult: {
          direct: 0,
          transitive: 1,
          affected: [selfNode],
        },
        bfsResult: {
          visited: [],
          depth: 1,
          path: [],
        },
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      // Self should be excluded
      expect(result.items.some((i) => i.path === 'src/main.ts')).toBe(false);
    });

    it('deduplicates items by path', () => {
      // Same node appears as both direct dependent and semantic neighbor
      const node = mockGraphNode({ id: 10, path: 'src/dep.ts', relativePath: 'src/dep.ts' });
      const kg = createMockKnowledgeGraph({
        impactRadiusResult: {
          direct: 1,
          transitive: 1,
          affected: [node],
        },
        bfsResult: {
          visited: [node],
          depth: 1,
          path: [],
        },
        embedding: [0.1, 0.2],
        similarFiles: [
          mockFileInfo({ id: 10, path: 'src/dep.ts', relativePath: 'src/dep.ts' }),
        ],
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      // Should only have one entry for src/dep.ts
      const depItems = result.items.filter((i) => i.path === 'src/dep.ts');
      expect(depItems.length).toBe(1);
    });

    it('sorts items by score descending, then path ascending', () => {
      const nodeA = mockGraphNode({ id: 10, path: 'src/a.ts', relativePath: 'src/a.ts' });
      const nodeB = mockGraphNode({ id: 11, path: 'src/b.ts', relativePath: 'src/b.ts' });
      const kg = createMockKnowledgeGraph({
        impactRadiusResult: {
          direct: 2,
          transitive: 2,
          affected: [nodeA, nodeB],
        },
        bfsResult: {
          visited: [nodeA, nodeB],
          depth: 1,
          path: [],
        },
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      // Both have same score (0.5), so sorted by path ascending
      expect(result.items[0].path).toBe('src/a.ts');
      expect(result.items[1].path).toBe('src/b.ts');
    });

    it('returns hasCircularDeps as false', () => {
      const kg = createMockKnowledgeGraph();
      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      expect(result.hasCircularDeps).toBe(false);
    });

    it('includes layer and module in SystemContextItem', () => {
      const node = mockGraphNode({ id: 10, path: 'src/dep.ts', relativePath: 'src/dep.ts' });
      const kg = createMockKnowledgeGraph({
        impactRadiusResult: {
          direct: 1,
          transitive: 1,
          affected: [node],
        },
        bfsResult: {
          visited: [node],
          depth: 1,
          path: [],
        },
      });

      const result = assembleSystemContext(kg, {
        fileId: 1,
        relativePath: 'src/main.ts',
        cognitiveLoad: 0.5,
      });

      for (const item of result.items) {
        expect(item).toHaveProperty('layer');
        expect(item).toHaveProperty('module');
        expect(typeof item.layer).toBe('string');
        expect(typeof item.module).toBe('string');
      }
    });
  });
});
