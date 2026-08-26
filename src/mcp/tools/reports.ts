import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { createProgressReporter } from './progress.js';

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
    async (args, extra) => {
      const progress = createProgressReporter(extra, 'debt_report');
      try {
        if (args.resolveAfter) {
          await progress(5, 100, 'running full debt detection (redundancy, pattern drift, architecture)');
          await deps.debt.detectDebt();
          await progress(90, 100, 'detection complete, building report');
        }
        const report = deps.debt.getReport();
        await progress(100, 100, 'done');
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
        if (args.root && args.root !== '.') {
          // The report always reflects the initialized project root
          // (PROJECTMIND_ROOT / cwd at server start). A different root
          // requires re-scanning that project first.
          return {
            content: [{ type: 'text', text: JSON.stringify({
              note: `Report reflects the initialized project root. Requested root '${args.root}' is not the active project — run scan_project with that root (or restart the server there) first.`,
              hint: 'Use scan_project { root } to index another project, switch_project to it, then retry.',
            }, null, 2) }],
          };
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