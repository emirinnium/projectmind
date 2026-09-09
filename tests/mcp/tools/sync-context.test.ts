import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSyncContextTool } from '../../../src/mcp/tools/sync-context.js';
import type { McpDependencies } from '../../../src/mcp/tools/types.js';

interface RegisteredTool {
  inputSchema: { safeParse: (value: unknown) => { success: boolean } };
  handler: (args: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

interface ServerToolRegistry {
  _registeredTools: Record<string, RegisteredTool>;
}

function payloadFrom(result: {
  content: Array<{ type: string; text: string }>;
}): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('sync_context MCP interface', () => {
  it('pushes context, pulls ranked memories, and returns enrichment evidence', async () => {
    const storeMemory = vi.fn();
    const server = new McpServer({ name: 'sync-context-test', version: '1.0.0' });
    const deps = {
      projectRoot: 'C:/project',
      kg: {
        getAgentSessions: vi.fn(() => []),
        startAgentSession: vi.fn(() => 42),
        storeMemory,
        getMemory: vi.fn(() => []),
        getFileByPath: vi.fn(() => ({ id: 7, relativePath: 'src/feature.ts' })),
        getDependents: vi.fn(() => [{ relativePath: 'src/consumer.ts' }]),
        getFileEmbedding: vi.fn(() => null),
      },
    } as unknown as McpDependencies;

    registerSyncContextTool(server, deps);
    const tool = (server as unknown as ServerToolRegistry)._registeredTools.sync_context;
    expect(tool).toBeDefined();
    expect(tool.inputSchema.safeParse({ agentId: 'agent-1', action: 'both' }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ action: 'both' }).success).toBe(false);

    const result = await tool.handler({
      agentId: 'agent-1',
      action: 'both',
      context: {
        currentFile: 'src/feature.ts',
        recentDecisions: [
          {
            file: 'src/feature.ts',
            decision: 'keep the boundary explicit',
            reasoning: 'the MCP contract depends on it',
            timestamp: '2026-09-09T00:00:00.000Z',
          },
        ],
        patternsUsed: ['evidence-first'],
        issuesFound: [
          {
            file: 'src/feature.ts',
            issue: 'needs a regression test',
            severity: 'low',
          },
        ],
        workingState: { phase: 'verification' },
      },
    });

    const payload = payloadFrom(result);
    expect(payload).toMatchObject({
      sessionId: 42,
      agentId: 'agent-1',
      action: 'both',
      pushed: true,
      enrichment: {
        status: 'complete',
        file: 'src/feature.ts',
        dependents: ['src/consumer.ts'],
        similar: [],
      },
      message: 'Context synchronized successfully',
    });
    expect(payload.pulled).toMatchObject({
      decisions: [],
      patterns: [],
      issues: [],
      sync: [],
    });
    expect(storeMemory).toHaveBeenCalledTimes(5);
    expect(storeMemory).toHaveBeenCalledWith(42, 'sync', 'current_file', 'src/feature.ts');
  });

  it('makes enrichment failure visible without failing the synchronization', async () => {
    const server = new McpServer({ name: 'sync-context-failure-test', version: '1.0.0' });
    const deps = {
      projectRoot: 'C:/project',
      kg: {
        getAgentSessions: vi.fn(() => [{ id: 9 }]),
        getMemory: vi.fn(() => []),
        getFileByPath: vi.fn(() => {
          throw new Error('graph unavailable');
        }),
      },
    } as unknown as McpDependencies;

    registerSyncContextTool(server, deps);
    const tool = (server as unknown as ServerToolRegistry)._registeredTools.sync_context;
    const result = await tool.handler({
      agentId: 'agent-1',
      action: 'pull',
      context: { currentFile: 'src/feature.ts' },
    });

    const payload = payloadFrom(result);
    expect(payload).toMatchObject({
      sessionId: 9,
      pulled: { decisions: [], patterns: [], issues: [], sync: [] },
      enrichment: { status: 'failed' },
      enrichmentError: 'graph unavailable',
    });
  });
});
