import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';

export function registerTeamMemoryTools(server: McpServer, deps: McpDependencies): void {
  // Store a team memory (shared across agents)
  server.registerTool(
    'store_team_memory',
    {
      title: 'Store Team Memory',
      description: 'Store a memory that is shared across all agents in the team. Use this for decisions, patterns, and knowledge that should be accessible to everyone.',
      inputSchema: {
        scope: z.string().describe('Memory scope (e.g., "architecture", "patterns", "decisions")'),
        key: z.string().describe('Memory key'),
        value: z.string().describe('Memory value'),
        isPublic: z.boolean().default(true).describe('Whether this memory is public to all agents'),
      },
    },
    async (args) => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'team-memory-store');
        }

        deps.kg.storeTeamMemory({
          agentName: deps.agentName || 'unknown',
          scope: args.scope,
          key: args.key,
          value: args.value,
          isPublic: args.isPublic,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, message: 'Team memory stored' }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }, null, 2),
            },
          ],
        };
      }
    }
  );

  // Get team memories
  server.registerTool(
    'get_team_memories',
    {
      title: 'Get Team Memories',
      description: 'Retrieve team memories by scope. Returns all public memories and private memories from the current agent.',
      inputSchema: {
        scope: z.string().describe('Memory scope to filter by'),
      },
    },
    async (args) => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'team-memory-get');
        }

        const memories = deps.kg.getTeamMemories({
          scope: args.scope,
          agentName: deps.agentName || 'unknown',
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, count: memories.length, memories }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }, null, 2),
            },
          ],
        };
      }
    }
  );
}
