import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';
import { searchTeamMemoriesSemantic } from '../../core/memory/semantic-memory.js';
import { buildMergeSuggestion, type MergeSuggestion } from '../../core/team-memory/merge.js';

export function registerTeamMemoryTools(server: McpServer, deps: McpDependencies): void {
  // Store a team memory (shared across agents)
  server.registerTool(
    'store_team_memory',
    {
      title: 'Store Team Memory',
      description:
        'Store a memory that is shared across all agents in the team. Use this for decisions, patterns, and knowledge that should be accessible to everyone. ' +
        'Concurrent writes are reconciled with a Git-style 3-way merge: identical/overlapping-safe values merge automatically, and genuine conflicts keep the stored value and return a resolution suggestion instead of silently overwriting.',
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

        const result = deps.kg.storeTeamMemory({
          agentName: deps.agentName || 'unknown',
          scope: args.scope,
          key: args.key,
          value: args.value,
          isPublic: args.isPublic,
        });

        let suggestion: MergeSuggestion | null = null;
        if (result.status === 'conflict') {
          suggestion = await buildMergeSuggestion(
            result.baseValueUsed,
            result.previousValue,
            args.value,
            result.conflicts,
            deps.llmProvider ?? null,
          );
        }

        const message =
          result.status === 'conflict'
            ? 'Conflict: overlapping concurrent changes — the stored value was kept unchanged. Review the suggestion and re-store a resolved value.'
            : result.status === 'merged'
              ? 'Team memory merged (3-way) and stored'
              : 'Team memory stored';

        const response: Record<string, unknown> = {
          success: true,
          status: result.status,
          message,
        };
        if (result.status === 'conflict') {
          response.previousValue = result.previousValue;
          response.conflictCount = result.conflicts.length;
          response.conflicts = result.conflicts;
          response.suggestion = suggestion;
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // Get team memories
  server.registerTool(
    'get_team_memories',
    {
      title: 'Get Team Memories',
      description:
        'Retrieve team memories by scope. Returns all public memories and private memories from the current agent.',
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
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // Semantic (RAG-style) team memory search
  server.registerTool(
    'search_team_memories',
    {
      title: 'Search Team Memories (Semantic)',
      description:
        'Retrieve team memories by SEMANTIC similarity to a natural-language query — not just exact scope/key.\n' +
        'WHEN to call: "has anyone solved this before?", "what did we decide about X?" — retrieves relevant past decisions/patterns even when you do not know the scope or key. Cosine-ranked over cached embeddings; works offline, upgrades automatically when a stronger embedding provider is initialized.',
      inputSchema: {
        query: z
          .string()
          .describe('Natural-language query (e.g. "how do we handle rate limiting")'),
        scope: z.string().optional().describe('Optional scope filter after ranking'),
        agentName: z.string().optional().describe('Optional author filter after ranking'),
        limit: z.number().default(5).describe('Max hits to return'),
        threshold: z.number().default(0.05).describe('Cosine floor; lower = broader recall'),
        maxTokens: z
          .number()
          .optional()
          .describe('Soft budget hint (~chars/4); caps returned hits when set'),
      },
    },
    async (args) => {
      try {
        const viewer = deps.agentName || args.agentName || 'unknown';
        const result = await searchTeamMemoriesSemantic(() => deps.kg.getAllTeamMemories(viewer), {
          query: args.query,
          scope: args.scope,
          agentName: args.agentName,
          limit:
            args.maxTokens && args.maxTokens > 0
              ? Math.min(args.limit, Math.max(1, Math.floor((args.maxTokens * 4) / 90)))
              : args.limit,
          threshold: args.threshold,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}
