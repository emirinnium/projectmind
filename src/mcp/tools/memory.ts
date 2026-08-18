import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';

export function registerStoreMemoryTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'store_memory',
    {
      title: 'Store Agent Memory',
      description: 'Store a piece of agent memory that persists across sessions.',
      inputSchema: {
        scope: z.string().describe('Scope identifier (e.g., module name, file path)'),
        key: z.string().describe('Memory key'),
        value: z.string().describe('Memory value (JSON-serializable)'),
        sessionId: z.number().optional().describe('Agent session ID'),
      },
    },
    async (args) => {
      let sid: number | undefined = args.sessionId;
      if (!sid) {
        const sessions = deps.kg.getAgentSessions();
        const latest = sessions[0];
        if (latest) {
          sid = latest.id;
        } else {
          sid = deps.kg.startAgentSession('mcp-agent');
        }
      }

      deps.kg.storeMemory(sid!, args.scope, args.key, args.value);

      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'stored', scope: args.scope, key: args.key }) }],
      };
    }
  );
}

export function registerGetMemoryTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'get_memory',
    {
      title: 'Get Agent Memory',
      description: 'Retrieve agent memory by scope and optionally by key.',
      inputSchema: {
        scope: z.string().describe('Scope identifier'),
        key: z.string().optional().describe('Specific key (omit for all keys in scope)'),
      },
    },
    async (args) => {
      const memories = deps.kg.getMemory(args.scope, args.key);
      return {
        content: [{ type: 'text', text: JSON.stringify(memories, null, 2) }],
      };
    }
  );
}