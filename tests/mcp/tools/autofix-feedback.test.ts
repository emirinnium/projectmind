import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAutoFixTool } from '@/mcp/tools/auto-fix.js';

interface RegisteredTool {
  handler: (args: unknown) => Promise<{ content: Array<{ text?: string }> }>;
}

describe('MCP auto-fix feedback interface', () => {
  it('records and recommends through the registered tool handlers', async () => {
    const db = new DatabaseSync(':memory:');
    const server = new McpServer({ name: 'autofix-feedback-test', version: '1.0.0' });
    const kg = { getCurrentProjectId: () => 1 };
    registerAutoFixTool(server, { db, kg, projectRoot: process.cwd() } as never);
    const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools;

    for (let index = 0; index < 3; index += 1) {
      const result = await tools.record_autofix_feedback.handler({
        fixer: 'var-to-const',
        feedback: 'accepted',
      });
      expect(JSON.parse(result.content[0]?.text ?? '{}').success).toBe(true);
    }
    const recommendation = await tools.recommend_autofix.handler({
      fixers: ['var-to-const'],
      minimumSamples: 3,
    });
    const payload = JSON.parse(recommendation.content[0]?.text ?? '{}') as {
      success: boolean;
      recommendations: Array<{ fixer: string; status: string; acceptanceRate: number }>;
    };
    expect(payload).toMatchObject({ success: true });
    expect(payload.recommendations[0]).toMatchObject({
      fixer: 'var-to-const',
      status: 'recommend',
      acceptanceRate: 1,
    });

    const optOut = await tools.set_autofix_feedback_opt_out.handler({
      agentName: 'test-agent',
      optedOut: true,
    });
    expect(JSON.parse(optOut.content[0]?.text ?? '{}')).toMatchObject({
      success: true,
      optedOut: true,
    });
    const reset = await tools.reset_autofix_feedback.handler({ agentName: 'test-agent' });
    expect(JSON.parse(reset.content[0]?.text ?? '{}').success).toBe(true);
    db.close();
  });
});
