import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReplayTool } from '@/mcp/tools/replay.js';

interface RegisteredTool {
  handler: (args: unknown) => Promise<{ content: Array<{ text?: string }> }>;
}

describe('MCP agent replay', () => {
  it('records metadata and reports a source-matched event', async () => {
    const root = mkdtempSync(join(process.env.TEMP ?? '.', 'projectmind-replay-'));
    const db = new DatabaseSync(':memory:');
    writeFileSync(join(root, 'auth.ts'), 'export const auth = true;\n', 'utf-8');
    const kg = {
      getCurrentProjectId: () => 1,
      getAllFiles: () => [],
    };
    const server = new McpServer({ name: 'replay-test', version: '1.0.0' });
    registerReplayTool(server, { db, kg, projectRoot: root } as never);
    const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools;

    const recorded = await tools.record_replay_event.handler({
      eventType: 'context',
      toolName: 'get_context',
      filePath: 'auth.ts',
      outcome: { selectedFiles: 1 },
    });
    const recordPayload = JSON.parse(recorded.content[0]?.text ?? '{}') as {
      success: boolean;
      event?: { id: number };
    };
    expect(recordPayload.success).toBe(true);
    expect(recordPayload.event?.id).toBe(1);

    const replayed = await tools.agent_replay.handler({
      filePath: 'auth.ts',
      verify: true,
    });
    const replayPayload = JSON.parse(replayed.content[0]?.text ?? '{}') as {
      success: boolean;
      events?: Array<{ status: string }>;
      verification?: { valid: boolean };
    };
    expect(replayPayload.success).toBe(true);
    expect(replayPayload.events?.[0]?.status).toBe('recorded');
    expect(replayPayload.verification?.valid).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
