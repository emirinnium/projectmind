import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { answerCodebaseQuestion } from '@/core/intelligence/qa-engine.js';
import { actionableMcpError } from '@/utils/actionable-error.js';

/** Evidence-first natural-language codebase Q&A. */
export function registerAskCodebaseTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'ask_codebase',
    {
      title: 'Ask Codebase',
      description:
        'Answer a natural-language JavaScript/TypeScript codebase question from bounded source excerpts. The default is offline and deterministic; optional LLM synthesis is constrained by source hashes, line ranges, freshness, and an explicit refusal when evidence is insufficient.',
      inputSchema: {
        question: z
          .string()
          .trim()
          .min(1)
          .max(8000)
          .describe('Question about the indexed codebase'),
        limit: z.number().int().min(1).max(20).default(5).describe('Maximum evidence files'),
        maxFilesToInspect: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(200)
          .describe('Bounded number of indexed files to inspect'),
        useLlm: z
          .boolean()
          .default(false)
          .describe('Use the configured provider to synthesize wording from evidence'),
      },
    },
    async (args) => {
      try {
        const result = await answerCodebaseQuestion(deps.kg, deps.projectRoot, args.question, {
          limit: args.limit,
          maxFilesToInspect: args.maxFilesToInspect,
          useLlm: args.useLlm,
          llmProvider: deps.llmProvider,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );
}
