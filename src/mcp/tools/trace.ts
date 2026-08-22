import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';

export function registerIngestTraceTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'ingest_trace',
    {
      title: 'Ingest Runtime Trace',
      description: 'Ingest runtime call trace data into the knowledge graph. Supports JSON arrays of trace events.',
      inputSchema: {
        traceData: z.array(z.object({
          fromFunctionName: z.string(),
          toFunctionName: z.string(),
          workloadId: z.string(),
          callCount: z.number().optional(),
          staticMissed: z.boolean().optional(),
        })).describe('Array of trace events from runtime execution'),
        workloadId: z.string().optional().describe('Workload identifier for grouping trace data'),
        clear: z.boolean().default(false).describe('Clear existing dynamic calls before ingest'),
      },
    },
    async (args) => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'trace-ingest');
        }

        const workloadId = args.workloadId || `trace-${Date.now()}`;

        if (args.clear) {
          deps.kg.clearDynamicCalls(workloadId);
        }

        const result = deps.kg.ingestDynamicCalls(
          args.traceData.map((c) => ({
            ...c,
            workloadId: c.workloadId || workloadId,
          }))
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                workloadId,
                inserted: result.inserted,
                updated: result.updated,
                errors: result.errors,
                totalProcessed: result.inserted + result.updated,
              }, null, 2),
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
