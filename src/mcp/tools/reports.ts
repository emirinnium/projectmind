import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';

export function registerDebtReportTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'debt_report',
    {
      title: 'Cognitive Debt Report',
      description: 'Generate a cognitive debt report for the project.',
      inputSchema: {
        resolveAfter: z.boolean().default(false).describe('Also run analysis before reporting'),
      },
    },
    async (args) => {
      try {
        if (args.resolveAfter) {
          await deps.debt.detectDebt();
        }
        const report = deps.debt.getReport();
        return {
          content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Debt report failed' }) }],
        };
      }
    }
  );
}

export function registerScaleReportTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'scale_report',
    {
      title: 'Project Scale Report',
      description: 'Get project scale, module coverage, and cognitive load metrics.',
      inputSchema: {
        root: z.string().default('.').describe('Root directory (note: uses initialized project root)'),
      },
    },
    async (args) => {
      try {
        // If root is specified and differs from current, log a note
        if (args.root && args.root !== '.') {
          // ScaleManager uses the root from initialization
          // For different root, re-scan would be needed
        }
        const report = deps.scale.getScaleReport();
        return {
          content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Scale report failed' }) }],
        };
      }
    }
  );
}

export function registerGenomeScoreTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'genome_score',
    {
      title: 'Coherence Genome Score',
      description: 'Compute and return the project coherence genome score.',
      inputSchema: {},
    },
    async () => {
      try {
        const genome = deps.debt.computeGenome();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                coherenceScore: genome.coherenceScore,
                scorePercentage: `${(genome.coherenceScore * 100).toFixed(1)}%`,
                genomeData: genome.genomeData,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Genome score computation failed' }) }],
        };
      }
    }
  );
}