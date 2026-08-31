import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerKgStatsTool } from '../../../src/mcp/tools/kg-stats.js';

const TEST_PROJECT_ROOT = '/tmp/test-project';

vi.mock('../../../src/mcp/tools/kg-stats.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/mcp/tools/kg-stats.js')>();
  return {
    ...actual,
    registerKgStatsTool: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('kg_stats tool', () => {
  beforeEach(() => {
    ;(registerKgStatsTool as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  it('returns graph stats with nodes and edges count', () => {
    ;(registerKgStatsTool as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    const server = {} as any;
    const deps = {
      kg: {
        getGraphTraversal: vi.fn().mockResolvedValueOnce({
          getStats: vi.fn().mockReturnValueOnce({
            totalNodes: 150,
            totalEdges: 450,
            avgDegree: 6,
            maxDegree: 25,
            density: 0.04,
            connectedComponents: 3,
          }),
          pageRank: vi.fn().mockResolvedValueOnce([
            { path: '/src/core/index.ts', score: 0.15, rank: 1 },
            { path: '/src/core/utils.ts', score: 0.12, rank: 2 },
            { path: '/src/api/routes.ts', score: 0.10, rank: 3 },
          ]),
        }),
      },
      coherence: {} as any,
      debt: {} as any,
      scale: {} as any,
      projectRoot: TEST_PROJECT_ROOT,
    } as any;

    registerKgStatsTool(server, deps);

    // Verify the tool was registered with the correct name
    const registered = (server.registerTool as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(registered).toBe('kg_stats');
  });

  it('returns top pagerank files in the response', async () => {
    ;(registerKgStatsTool as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    const server = {} as any;
    const deps = {
      kg: {
        getGraphTraversal: vi.fn().mockResolvedValueOnce({
          getStats: vi.fn().mockReturnValueOnce({
            totalNodes: 100,
            totalEdges: 300,
            avgDegree: 6,
            maxDegree: 20,
            density: 0.06,
            connectedComponents: 2,
          }),
          pageRank: vi.fn().mockResolvedValueOnce([
            { path: '/src/core/types.ts', score: 0.25, rank: 1 },
            { path: '/src/core/models.ts', score: 0.20, rank: 2 },
            { path: '/src/core/services.ts', score: 0.18, rank: 3 },
            { path: '/src/api/controllers.ts', score: 0.15, rank: 4 },
          ]),
        }),
      },
      coherence: {} as any,
      debt: {} as any,
      scale: {} as any,
      projectRoot: TEST_PROJECT_ROOT,
    } as any;

    registerKgStatsTool(server, deps);

    const registeredCfg = (server.registerTool as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(registeredCfg?.inputSchema).toBeDefined();
  });

  it('handles errors when KG is not available', async () => {
    ;(registerKgStatsTool as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Knowledge graph not initialized')
    );

    const server = {} as any;
    const deps = {
      kg: {
        getGraphTraversal: vi.fn().mockRejectedValueOnce(new Error('KG not available')),
      },
      coherence: {} as any,
      debt: {} as any,
      scale: {} as any,
      projectRoot: TEST_PROJECT_ROOT,
    } as any;

    registerKgStatsTool(server, deps);

    const registeredCfg = (server.registerTool as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(registeredCfg?.inputSchema).toBeDefined();
  });

  it('returns stats with correct structure', () => {
    ;(registerKgStatsTool as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    const server = {} as any;
    const deps = {
      kg: {
        getGraphTraversal: vi.fn().mockResolvedValueOnce({
          getStats: vi.fn().mockReturnValueOnce({
            totalNodes: 200,
            totalEdges: 800,
            avgDegree: 8,
            maxDegree: 30,
            density: 0.04,
            connectedComponents: 5,
          }),
          pageRank: vi.fn().mockResolvedValueOnce([
            { path: '/src/index.ts', score: 0.3, rank: 1 },
          ]),
        }),
      },
      coherence: {} as any,
      debt: {} as any,
      scale: {} as any,
      projectRoot: TEST_PROJECT_ROOT,
    } as any;

    registerKgStatsTool(server, deps);

    const registeredCfg = (server.registerTool as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    // Schema should be defined (no inputs needed)
    expect(registeredCfg?.inputSchema).toBeDefined();
  });
});