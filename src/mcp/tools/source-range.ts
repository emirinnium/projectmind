import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { readSourceRange } from '@/core/retrieval/byte-range.js';
import { asUntrustedContent } from '@/mcp/security/untrusted-content.js';
import { actionableMcpError } from '@/utils/actionable-error.js';

export function registerSourceRangeTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'get_source_range',
    {
      title: 'Get Source Byte Range',
      description:
        'Read only an exact UTF-8 byte range from a current project source file. Returns byte/line coordinates, source hash, line ending, truncation and a next range instead of loading the entire file.',
      inputSchema: {
        filePath: z.string().trim().min(1).max(1000).describe('Project-relative source path'),
        startByte: z.number().int().min(0).max(50_000_000),
        endByte: z.number().int().min(0).max(50_000_000),
        maxBytes: z.number().int().min(1).max(1_000_000).default(65_536),
      },
    },
    async (args) => {
      try {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                (() => {
                  const range = readSourceRange(
                    args.filePath,
                    deps.projectRoot,
                    args.startByte,
                    args.endByte,
                    args.maxBytes,
                  );
                  return {
                    ...range,
                    untrustedContent: asUntrustedContent(range.content, 'source', {
                      relativePath: range.filePath,
                      byteStart: range.startByte,
                      byteEnd: range.endByte,
                    }),
                  };
                })(),
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
