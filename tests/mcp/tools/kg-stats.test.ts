import { describe, expect, it, vi } from 'vitest';
import { registerKgStatsTool } from '../../../src/mcp/tools/kg-stats.js';
import type { McpDependencies } from '../../../src/mcp/tools/types.js';

interface RegisteredTool {
  inputSchema: Record<string, never>;
  handler: () => Promise<{ content: Array<{ text: string }> }>;
}

function registerFixture() {
  const traversal = {
    getStats: vi.fn(() => ({
      totalNodes: 150,
      totalEdges: 450,
      avgDegree: 6,
      maxDegree: 25,
      density: 0.04,
      connectedComponents: 3,
    })),
    pageRank: vi.fn(() => [
      { path: '/src/core/index.ts', score: 0.15, rank: 1 },
      { path: '/src/core/utils.ts', score: 0.12, rank: 2 },
    ]),
  };
  const server = { registerTool: vi.fn() };
  const deps = {
    kg: {
      getGraphTraversal: vi.fn(() => traversal),
      getFileByPath: vi.fn(() => null),
    },
    projectRoot: '/tmp/test-project',
  } as unknown as McpDependencies;

  registerKgStatsTool(server as never, deps);
  const call = server.registerTool.mock.calls[0] as unknown as [
    string,
    RegisteredTool,
    () => Promise<unknown>,
  ];
  return {
    traversal,
    server,
    name: call[0],
    config: call[1],
    handler: call[2],
  };
}

describe('kg_stats MCP tool', () => {
  it('registers a no-input schema under the canonical name', () => {
    const fixture = registerFixture();
    expect(fixture.name).toBe('kg_stats');
    expect(fixture.config.inputSchema).toBeDefined();
  });

  it('builds one fresh graph snapshot and uses it for every metric', async () => {
    const fixture = registerFixture();
    const result = (await fixture.handler()) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0].text) as {
      success: boolean;
      nodes: number;
      edges: number;
      topPagerank: Array<{ path: string; score: number; rank: number }>;
    };

    expect(payload).toMatchObject({ success: true, nodes: 150, edges: 450 });
    expect(payload.topPagerank[0]).toEqual({
      path: '/src/core/index.ts',
      score: 0.15,
      rank: 1,
    });
    expect(fixture.traversal.getStats).toHaveBeenCalledTimes(1);
    expect(fixture.traversal.pageRank).toHaveBeenCalledTimes(1);
    expect(
      (fixture.server.registerTool.mock.calls[0] as unknown as [string, object, unknown])[0],
    ).toBe('kg_stats');
  });

  it('returns a structured failure when graph construction fails', async () => {
    const server = { registerTool: vi.fn() };
    const deps = {
      kg: {
        getGraphTraversal: vi.fn(() => {
          throw new Error('KG not available');
        }),
      },
      projectRoot: '/tmp/test-project',
    } as unknown as McpDependencies;
    registerKgStatsTool(server as never, deps);
    const handler = (
      server.registerTool.mock.calls[0] as unknown as [string, object, () => Promise<unknown>]
    )[2];
    const result = (await handler()) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: false,
      error: 'KG not available',
    });
  });
});
