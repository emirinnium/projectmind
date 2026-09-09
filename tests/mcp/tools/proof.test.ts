import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerProveClaimTool,
  registerVerifyFreshnessTool,
} from '../../../src/mcp/tools/proof.js';
import type { McpDependencies } from '../../../src/mcp/tools/types.js';
import type { KnowledgeGraph } from '../../../src/storage/knowledge-graph.js';
import { stableHash } from '../../../src/utils/hash.js';

interface RegisteredTool {
  inputSchema?: unknown;
  handler: (...args: never[]) => unknown;
}

interface ServerRegistry {
  _registeredTools: Record<string, RegisteredTool>;
}

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const path = directories.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe('MCP proof tools', () => {
  it('returns an explicit insufficient-evidence response for a claim without files', async () => {
    const server = new McpServer({ name: 'proof-test', version: '1.0.0' });
    const deps = { projectRoot: '.', kg: {} } as unknown as McpDependencies;
    registerProveClaimTool(server, deps);
    const tool = (server as unknown as ServerRegistry)._registeredTools.prove_claim;
    const handler = tool.handler as unknown as (args: { claim: string }) => Promise<{
      content: Array<{ text: string }>;
    }>;

    const result = await handler({ claim: 'This claim is not source-backed.' });
    const payload = JSON.parse(result.content[0].text) as {
      claimStatus: string;
      evidence: { confidence: number };
    };
    expect(payload.claimStatus).toBe('insufficient-evidence');
    expect(payload.evidence.confidence).toBe(0);
  });

  it('exposes schema and detailed fresh/stale results through both tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'projectmind-mcp-proof-'));
    directories.push(root);
    const relativePath = 'example.ts';
    const absolutePath = join(root, relativePath);
    const content = 'export const value = 1;\n';
    await writeFile(absolutePath, content, 'utf8');
    const graph = {
      getFileByPath: (path: string) =>
        path === relativePath || path === absolutePath
          ? {
              path: absolutePath,
              relativePath,
              hash: stableHash(content),
              lastScanned: '2026-09-08 12:00:00',
            }
          : null,
      getAllFiles: () => [
        {
          path: absolutePath,
          relativePath,
          hash: stableHash(content),
          lastScanned: '2026-09-08 12:00:00',
        },
      ],
    } as unknown as KnowledgeGraph;
    const deps = { projectRoot: root, kg: graph } as unknown as McpDependencies;
    const server = new McpServer({ name: 'proof-test', version: '1.0.0' });
    registerProveClaimTool(server, deps);
    registerVerifyFreshnessTool(server, deps);
    const tools = (server as unknown as ServerRegistry)._registeredTools;
    expect(tools.prove_claim.inputSchema).toBeDefined();
    expect(tools.verify_freshness.inputSchema).toBeDefined();

    const verify = tools.verify_freshness.handler as unknown as (args: {
      filePaths: string[];
      maxFiles: number;
    }) => Promise<{ content: Array<{ text: string }> }>;
    const result = await verify({ filePaths: [relativePath], maxFiles: 10 });
    const payload = JSON.parse(result.content[0].text) as {
      evidence: { claimStatus: string; freshness: { freshFiles: number } };
    };
    expect(payload.evidence.claimStatus).toBe('verified');
    expect(payload.evidence.freshness.freshFiles).toBe(1);
  });
});
