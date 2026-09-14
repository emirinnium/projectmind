import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { summarizeInvocationMetrics } from '@/core/telemetry/invocation.js';

export function registerInvocationMetricsTool(server: McpServer, _deps: McpDependencies): void {
  server.registerTool(
    'get_invocation_metrics',
    {
      title: 'Get MCP Invocation Metrics',
      description:
        'Return in-process MCP latency, cold/warm, input/output-byte and estimated-token aggregates. Metrics are observational and never treated as review correctness or confidence.',
      inputSchema: {
        tool: z.string().trim().min(1).max(200).optional().describe('Optional exact MCP tool name'),
      },
    },
    async (args) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              metrics: summarizeInvocationMetrics(args.tool),
              limitations: [
                'Metrics cover this server process only; they are not a cross-machine comparison.',
              ],
              nextAction: 'Use repeated cold and warm runs to compare p50/p95/p99.',
            },
            null,
            2,
          ),
        },
      ],
    }),
  );
}
