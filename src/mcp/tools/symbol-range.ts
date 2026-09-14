import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { getDatabase } from '@/storage/database.js';
import { readSourceSymbolRange, type SourceRangeKind } from '@/core/retrieval/source-index.js';
import { asUntrustedContent } from '@/mcp/security/untrusted-content.js';
import { actionableMcpError } from '@/utils/actionable-error.js';

const SOURCE_RANGE_KINDS = ['function', 'class', 'method', 'property', 'import', 'export'] as const;

/** Read a current indexed symbol without loading unrelated source ranges. */
export function registerSourceSymbolRangeTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'get_source_symbol_range',
    {
      title: 'Get Indexed Source Symbol',
      description:
        'Read a bounded source range for a named JS/TS symbol from the persisted AST coordinate index. Rejects stale indexes and ambiguous names instead of guessing.',
      inputSchema: {
        filePath: z.string().trim().min(1).max(1000).describe('Project-relative source path'),
        symbol: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe('Exact symbol name or class.symbol path'),
        kind: z.enum(SOURCE_RANGE_KINDS).optional().describe('Optional symbol kind filter'),
        occurrence: z.number().int().min(1).max(1000).optional(),
        maxBytes: z.number().int().min(1).max(1_000_000).default(65_536),
      },
    },
    async (args) => {
      try {
        const range = readSourceSymbolRange(
          deps.db ?? getDatabase(),
          args.filePath,
          deps.projectRoot,
          deps.kg.getCurrentProjectId(),
          args.symbol,
          {
            kind: args.kind as SourceRangeKind | undefined,
            occurrence: args.occurrence,
            maxBytes: args.maxBytes,
          },
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ...range,
                  untrustedContent: asUntrustedContent(range.content, 'source', {
                    relativePath: range.filePath,
                    byteStart: range.startByte,
                    byteEnd: range.endByte,
                  }),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );
}
