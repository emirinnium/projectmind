import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCanonicalExampleTool } from '../../../src/mcp/tools/canonical-example.js';

describe('get_canonical_example MCP interface', () => {
  it('registers a typed schema and returns source-backed structured evidence', async () => {
    const server = new McpServer({ name: 'canonical-test', version: '1.0.0' });
    const root = process.cwd();
    registerCanonicalExampleTool(server, {
      projectRoot: root,
      kg: {
        getAllFiles: () => [
          {
            id: 1,
            path: `${root}/src/core/search/history-ranking.ts`,
            relativePath: 'src/core/search/history-ranking.ts',
            language: 'typescript',
            sizeBytes: 1,
            hash: 'x',
            agentTouched: false,
            agentTouchedBy: null,
            agentTouchedAt: null,
            cognitiveLoad: 1,
            lastScanned: new Date().toISOString(),
            lastSynced: new Date().toISOString(),
            patterns: [],
          },
        ],
        getImports: () => [],
        getDependents: () => [],
      },
    } as never);
    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            inputSchema: { safeParse: (v: unknown) => { success: boolean } };
            handler: (v: unknown) => Promise<{ content: Array<{ text: string }> }>;
          }
        >;
      }
    )._registeredTools;
    expect(tools.get_canonical_example.inputSchema.safeParse({ query: 'history' }).success).toBe(
      true,
    );
    expect(tools.get_canonical_example.inputSchema.safeParse({ query: '' }).success).toBe(false);
    const result = await tools.get_canonical_example.handler({ query: 'history', limit: 5 });
    const payload = JSON.parse(result.content[0].text) as {
      selected?: { path: string };
      evidence: string[];
    };
    expect(payload.selected?.path).toBe('src/core/search/history-ranking.ts');
    expect(payload.evidence.length).toBeGreaterThan(0);
  });
});
