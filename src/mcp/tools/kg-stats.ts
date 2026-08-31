import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { confineToProject } from './_shared.js';

/**
 * kg-stats — returns knowledge graph statistics:
 * - nodes (count)
 * - edges (count)
 * - topPagerank (array of file paths ranked by PageScore)
 *
 * WHEN to call: before refactors or impact analysis to understand
 * the graph structure and critical files.
 */
export function registerKgStatsTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'kg_stats',
    {
      title: 'Knowledge Graph Stats',
      description:
        'Return knowledge graph statistics: node count, edge count, and top files by PageRank score.\n' +
        'Read-only tool for understanding graph structure and critical files.',
      inputSchema: {
        // No inputs needed; the tool queries the full graph state.
      },
    },
    async (_args, { _meta }) => {
      try {
        const kg = deps.kg;

        // Build/adjugacy graph to ensure fresh stats
        await kg.getGraphTraversal(true);

        // Get basic graph statistics
        const stats = kg.getGraphTraversal(true).getStats();

        // Get PageRank rankings to identify top files
        const pagerankResults = kg.getGraphTraversal(true).pageRank(20, 0.85);

        // Extract top file paths from PageRank, confined to project root
        const topPagerank = pagerankResults
          .slice(0, 10)
          .map((r) => {
            const fileInfo = kg.getFileByPath(r.path);
            if (fileInfo) {
              const absPath = confineToProject(fileInfo.relativePath || fileInfo.path, deps.projectRoot);
              return { path: absPath, score: Number(r.score.toFixed(6)), rank: r.rank };
            }
            return { path: r.path, score: Number(r.score.toFixed(6)), rank: r.rank };
          });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                nodes: stats.totalNodes,
                edges: stats.totalEdges,
                topPagerank,
                avgDegree: stats.avgDegree,
                maxDegree: stats.maxDegree,
                density: stats.density,
                connectedComponents: stats.connectedComponents,
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