import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import {
  LearnedSearchReranker,
  type SearchRankingFeatures,
} from '@/core/search/learned-reranker.js';
import { actionableMcpError } from '@/utils/actionable-error.js';

/** Record an explicit, source-free search preference for the local reranker. */
export function registerSearchFeedbackTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'record_search_feedback',
    {
      title: 'Record Search Feedback',
      description:
        'Record whether an agent selected, opened, included, or skipped a search result. Only a query hash, project-relative path, and numeric ranking features are stored; source text and query text are never persisted. The learned reranker remains disabled until sufficient positive and skipped observations exist.',
      inputSchema: {
        query: z.string().trim().min(1).max(8000).describe('Search query used for the result'),
        resultPath: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .describe('Project-relative result path from the search response'),
        position: z.number().int().min(1).max(1000).describe('Original result position'),
        feedback: z
          .enum(['selected', 'opened', 'included', 'skipped'])
          .describe('Observed result interaction'),
        features: z
          .object({
            lexical: z.number().finite().min(0).max(1),
            vector: z.number().finite().min(0).max(1),
            graph: z.number().finite().min(0).max(1),
            history: z.number().finite().min(0).max(1),
            freshness: z.number().finite().min(0).max(1),
            fileType: z.number().finite().min(0).max(1),
            pathDepth: z.number().finite().min(0).max(1),
            canonical: z.number().finite().min(0).max(1),
          })
          .describe('Numeric feature vector returned/derived for this result'),
        agentName: z.string().trim().min(1).max(200).optional().describe('Optional agent identity'),
      },
    },
    async (args) => {
      try {
        if (!deps.db) throw new Error('Search feedback requires an initialized project database.');
        const reranker = new LearnedSearchReranker(deps.db, deps.kg.getCurrentProjectId(), {
          projectRoot: deps.projectRoot,
        });
        const recorded = reranker.recordFeedback({
          query: args.query,
          resultPath: args.resultPath,
          position: args.position,
          feedback: args.feedback,
          features: args.features as SearchRankingFeatures,
          agentName: args.agentName ?? deps.agentName,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                interactionId: recorded.id,
                learning: recorded.status,
                privacy: {
                  queryStored: false,
                  sourceContentStored: false,
                  pathStored: 'project-relative',
                },
              }),
            },
          ],
        };
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );
}
