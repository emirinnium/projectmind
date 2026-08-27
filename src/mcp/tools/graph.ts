import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { createProgressReporter } from './progress.js';

/**
 * kg_query — agent-facing surface for the in-memory graph engine
 * (BFS traversal, shortest path, PageRank, community detection,
 * N-hop subgraph extraction, impact radius).
 *
 * This is the "2-hop subgraph around the file I want to change" tool:
 * agents call it BEFORE refactors to understand blast radius structurally
 * (graph algorithms), complementing analyze_impact (reverse-dependency BFS).
 */

const inputSchema = {
  action: z.enum(['stats', 'pagerank', 'communities', 'subgraph', 'path', 'impact', 'bfs']).describe(
    'Graph operation: stats=nodes/edges overview, pagerank=critical files by score, communities=module clusters, subgraph=N-hop neighborhood around file, path=shortest import chain from→to, impact=direct+transitive affected set of file, bfs=traversal from file'
  ),
  file: z.string().optional().describe('File path (relative or absolute) — required for subgraph/impact/bfs, endpoint for path'),
  to: z.string().optional().describe('Target file path — required for action=path'),
  hops: z.number().default(2).describe('Radius for subgraph / depth for bfs (default 2)'),
  limit: z.number().default(15).describe('Max results for pagerank/communities listing'),
  damping: z.number().default(0.85).describe('PageRank damping factor'),
};

function json(result: object): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export function registerGraphQueryTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'kg_query',
    {
      title: 'Knowledge Graph Query',
      description:
        'Run real graph algorithms over the project knowledge graph.\n' +
        'WHEN to call: before refactors ("give me the 2-hop subgraph around this file"), to find critical files (pagerank), detect module clusters (communities), or compute the shortest import chain between two files (path).\n' +
        'Returns structured JSON per action. Read-only.',
      inputSchema,
    },
    async (args, extra) => {
      const progress = createProgressReporter(extra, 'kg_query');
      try {
        const kg = deps.kg;
        // Rebuild adjacency when explicitly asked via env-free heuristic:
        // always rebuild here — build cost is O(import rows) and results
        // must never be stale; cached instance reused within this call.
        await progress(10, 100, 'building adjacency');
        const g = kg.getGraphTraversal(true);

        const resolveFile = (p?: string): { id: number; rel: string } | null => {
          if (!p) return null;
          const info = kg.getFileByPath(p) ?? kg.getFileByPath(p.replace(/\\/g, '/'));
          return info ? { id: info.id, rel: info.relativePath || info.path } : null;
        };

        switch (args.action) {
          case 'stats': {
            await progress(60, 100, 'computing stats');
            const s = g.getStats();
            await progress(100, 100, 'done');
            return json({ success: true, action: 'stats', ...s });
          }
          case 'pagerank': {
            await progress(40, 100, `pageRank iterations on graph`);
            const ranked = g.pageRank(20, args.damping).slice(0, Math.max(1, args.limit));
            await progress(100, 100, 'done');
            return json({
              success: true,
              action: 'pagerank',
              note: 'Higher score = more the rest of the graph depends on this file. Change carefully.',
              topFiles: ranked.map((r) => ({ rank: r.rank, path: r.path, score: Number(r.score.toFixed(6)) })),
            });
          }
          case 'communities': {
            await progress(50, 100, 'detecting communities');
            const communities = g.detectCommunities();
            await progress(100, 100, 'done');
            return json({
              success: true,
              action: 'communities',
              count: communities.length,
              communities: communities.slice(0, Math.max(1, args.limit)).map((c) => ({
                id: c.id,
                density: Number(c.density.toFixed(3)),
                internalEdges: c.internalEdges,
                externalEdges: c.externalEdges,
                size: c.members.length,
                members: c.members.slice(0, 20).map((m) => m.relativePath || m.path),
              })),
            });
          }
          case 'subgraph':
          case 'impact':
          case 'bfs': {
            const f = resolveFile(args.file);
            if (!f) {
              return json({ success: false, error: `'file' is required for action='${args.action}' and must exist in the knowledge graph (run scan_project first).` });
            }
            if (args.action === 'subgraph') {
              await progress(50, 100, `extracting ${args.hops}-hop subgraph`);
              const sg = g.extractSubgraph(f.id, Math.max(1, args.hops));
              await progress(100, 100, 'done');
              return json({
                success: true,
                action: 'subgraph',
                center: f.rel,
                radius: sg.radius,
                nodeCount: sg.nodes.length,
                // Node ids are included so `edges` (file-id pairs) are joinable.
                nodes: sg.nodes.map((n) => ({ id: n.id, path: n.relativePath || n.path, load: n.cognitiveLoad })),
                edges: sg.edges.map((e) => ({ from: e.from, to: e.to, type: e.type })),
              });
            }
            if (args.action === 'impact') {
              await progress(50, 100, 'computing impact radius');
              const ir = g.getImpactRadius(f.id);
              const tests = g.getTestsFor(f.id);
              await progress(100, 100, 'done');
              return json({
                success: true,
                action: 'impact',
                file: f.rel,
                directDependents: ir.direct,
                transitiveDependents: ir.transitive,
                affected: ir.affected.slice(0, Math.max(1, args.limit)).map((n) => ({ path: n.relativePath || n.path, load: n.cognitiveLoad })),
                tests: {
                  count: tests.length,
                  files: tests.slice(0, Math.max(1, args.limit)).map((n) => n.relativePath || n.path),
                  note: 'Direct test files importing this source — run these after changing it.',
                },
              });
            }
            await progress(50, 100, `BFS depth ${args.hops}`);
            const t = g.bfs(f.id, Math.max(1, args.hops));
            await progress(100, 100, 'done');
            return json({
              success: true,
              action: 'bfs',
              start: f.rel,
              visitedDepth: t.depth,
              visited: t.visited.slice(0, Math.max(1, args.limit)).map((n) => n.relativePath || n.path),
            });
          }
          case 'path': {
            const from = resolveFile(args.file);
            const to = resolveFile(args.to);
            if (!from || !to) {
              return json({ success: false, error: "action='path' requires both 'file' (from) and 'to' to exist in the knowledge graph." });
            }
            await progress(50, 100, 'searching shortest path');
            const p = g.shortestPath(from.id, to.id, 20);
            await progress(100, 100, 'done');
            return json({
              success: true,
              action: 'path',
              found: p.found,
              distance: p.distance,
              path: p.path.length > 0 ? p.path : undefined,
              hops: p.found ? p.hops.map((n) => n.relativePath || n.path) : undefined,
            });
          }
        }
      } catch (error) {
        return json({ success: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  );
}
