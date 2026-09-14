import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { annotateToolRegistration } from '@/mcp/tools/guard.js';
import { registerArbitrateAgentsTool } from '@/mcp/tools/arbiter.js';
import { EvidenceLedger } from '@/core/ledger/evidence-ledger.js';
import { createTestKnowledgeGraph } from '../../test-helpers/knowledge-graph.js';
import type { McpDependencies } from '@/mcp/tools/types.js';

interface RegisteredTool {
  inputSchema: { safeParse: (value: unknown) => { success: boolean } };
  handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }>;
}

function registered(server: McpServer): RegisteredTool {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools.arbitrate_agents;
}

describe('arbitrate_agents MCP tool', () => {
  it('registers a complete schema and returns a useful advisory report', async () => {
    const testGraph = createTestKnowledgeGraph();
    try {
      const server = new McpServer({ name: 'arbiter-test', version: '1.0.0' });
      annotateToolRegistration(server);
      registerArbitrateAgentsTool(server, {
        kg: testGraph.kg,
        db: testGraph.db,
      } as McpDependencies);
      const tool = registered(server);

      expect(tool.inputSchema.safeParse({ agents: [] }).success).toBe(false);
      expect(
        tool.inputSchema.safeParse({
          agents: [
            { agentName: 'agent-a', files: ['src/a.ts'] },
            { agentName: 'agent-b', files: ['src/b.ts'] },
          ],
          recordEvidence: false,
        }).success,
      ).toBe(true);
      expect(
        tool.inputSchema.safeParse({
          agents: [
            { agentName: 'same', files: ['src/a.ts'] },
            { agentName: 'same', files: ['src/b.ts'] },
          ],
        }).success,
      ).toBe(false);

      const response = await tool.handler({
        agents: [
          { agentName: 'agent-b', files: ['src/b.ts'] },
          { agentName: 'agent-a', files: ['src/a.ts'] },
        ],
        recordEvidence: false,
      });
      const payload = JSON.parse(response.content[0]!.text) as {
        success: boolean;
        report: {
          version: string;
          agents: string[];
          pairRisks: unknown[];
          recommendedRebaseOrder: string[];
        };
        ledger: { recorded: boolean };
      };
      expect(payload.success).toBe(true);
      expect(payload.report.version).toBe('projectmind-arbiter-v1');
      expect(payload.report.agents).toEqual(['agent-a', 'agent-b']);
      expect(payload.report.pairRisks).toHaveLength(1);
      expect(payload.report.recommendedRebaseOrder).toEqual(['agent-a', 'agent-b']);
      expect(payload.ledger).toEqual({
        recorded: false,
        reason: 'Evidence recording was disabled for this invocation.',
      });
    } finally {
      testGraph.cleanup();
    }
  });

  it('records only a hash-chain receipt by default', async () => {
    const testGraph = createTestKnowledgeGraph();
    try {
      const server = new McpServer({ name: 'arbiter-ledger-test', version: '1.0.0' });
      annotateToolRegistration(server);
      registerArbitrateAgentsTool(server, {
        kg: testGraph.kg,
        db: testGraph.db,
      } as McpDependencies);

      const response = await registered(server).handler({
        agents: [
          { agentName: 'agent-a', files: ['src/a.ts'] },
          { agentName: 'agent-b', files: ['src/b.ts'] },
        ],
      });
      const payload = JSON.parse(response.content[0]!.text) as {
        success: boolean;
        ledger: { recorded: boolean; recordId: number; recordHash: string };
      };
      expect(payload.success).toBe(true);
      expect(payload.ledger.recorded).toBe(true);
      expect(payload.ledger.recordId).toBe(1);
      expect(payload.ledger.recordHash).toMatch(/^[a-f0-9]{64}$/);
      expect(new EvidenceLedger(testGraph.db, 1).verify().valid).toBe(true);
    } finally {
      testGraph.cleanup();
    }
  });
});
