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
      if (args.resolveAfter) {
        await deps.debt.detectDebt();
      }
      const report = deps.debt.getReport();
      return {
        content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
      };
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
        root: z.string().default('.').describe('Root directory'),
      },
    },
    async () => {
      const report = deps.scale.getScaleReport();
      return {
        content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
      };
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
    }
  );
}