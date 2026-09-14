import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { buildBugSurfaceReport } from '@/core/predictive/bug-surface.js';
import { actionableMcpError } from '@/utils/actionable-error.js';

function json(value: object): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Register the deterministic predictive bug-surface analysis. */
export function registerBugSurfaceTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'predict_bug_surface',
    {
      title: 'Predictive Bug Surface',
      description:
        'Rank indexed JavaScript/TypeScript files by transparent change-risk signals: recorded failures, churn, ownership spread, complexity, graph dependents, debt, and coherence history. This is a risk ranking, not a calibrated probability or proof of a bug.',
      inputSchema: {
        sinceDays: z.number().int().min(1).max(3650).default(90).describe('Git history window'),
        limit: z.number().int().min(1).max(500).default(20).describe('Maximum files to return'),
        minimumScore: z.number().finite().min(0).max(1).default(0).describe('Minimum score filter'),
      },
    },
    async (args) => {
      try {
        if (!deps.db) throw new Error('predict_bug_surface requires an initialized database.');
        return json({
          success: true,
          report: buildBugSurfaceReport(deps.db, deps.kg, deps.projectRoot, {
            sinceDays: args.sinceDays,
            limit: args.limit,
            minimumScore: args.minimumScore,
          }),
        });
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );
}
