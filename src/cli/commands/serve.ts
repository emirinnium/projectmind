import { Command } from 'commander';
import http from 'node:http';
import { withService, output } from '@/cli/utils/shared.js';

/**
 * pm serve — local web dashboard (functional).
 *
 * Zero-dependency node:http server bound to 127.0.0.1 serving:
 *   GET /            single-page dashboard (inline HTML/CSS/JS, no CDN)
 *   GET /api/summary scale report + genome score + debt counts
 *   GET /api/graph   knowledge-graph overview: stats + PageRank top-N +
 *                    import edges among those nodes (for the mini-map)
 *
 * Data source is the SAME live SQLite knowledge graph the MCP server uses —
 * open this next to your coding session and refresh to see updates.
 */
export function createServeCommand(): Command {
  return new Command('serve')
    .description('Serve a local web dashboard over the live knowledge graph')
    .option('--port <n>', 'Port to listen on', '7788')
    .action(async (opts: { port?: string }) => {
      const port = Math.max(1, Math.min(65535, parseInt(opts.port ?? '7788', 10) || 7788));

      await withService(['debt'], async (_ctx, services) => {
        const kg = _ctx.kg;

        const getSummary = () => {
          const report = services.debt!.getReport();
          const high = Array.isArray(report.items) ? report.items.filter((i: { severity?: string }) => i.severity === 'high').length : 0;
          const medium = Array.isArray(report.items) ? report.items.filter((i: { severity?: string }) => i.severity === 'medium').length : 0;
          const low = Array.isArray(report.items) ? report.items.filter((i: { severity?: string }) => i.severity === 'low').length : 0;
          return {
            generatedAt: new Date().toISOString(),
            debt: { totalItems: report.totalItems ?? (Array.isArray(report.items) ? report.items.length : 0), high, medium, low },
          };
        };

        const getGraph = () => {
          const g = kg.getGraphTraversal(true);
          const stats = g.getStats();
          // NOTE: pageRank's first arg is ITERATIONS; cap the returned list here.
          const ranked = g.pageRank(20, 0.85).slice(0, 25);
          // Edges restricted to the visualized subgraph keep the payload tiny.
          const center = ranked[0];
          let edges: Array<{ from: string; to: string; type: string }> = [];
          if (center) {
            const info = kg.getFileByPath(center.path);
            if (info) {
              const sg = g.extractSubgraph(info.id, 2);
              const pathById = new Map<number, string>();
              for (const n of sg.nodes) pathById.set(n.id, n.relativePath || n.path);
              const topPaths = new Set(ranked.map((r) => r.path));
              edges = sg.edges
                .map((e) => ({ from: pathById.get(e.from) ?? '', to: pathById.get(e.to) ?? '', type: e.type }))
                .filter((e) => e.from && e.to && (topPaths.has(e.from) || topPaths.has(e.to)));
            }
          }
          return { stats, pageRank: ranked.map((r) => ({ path: r.path, score: Number(r.score.toFixed(5)) })), edges };
        };

        const server = http.createServer((req, res) => {
          void (async () => {
            try {
              if (req.method === 'GET' && req.url === '/api/summary') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(getSummary()));
                return;
              }
              if (req.method === 'GET' && req.url === '/api/graph') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(getGraph()));
                return;
              }
              if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(renderPage());
                return;
              }
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'not found' }));
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
            }
          })();
        });

        // Daemon pattern: NO asyncHandler success-exit here (see mcp.ts lesson).
        const host = process.env.PROJECTMIND_SERVER_HOST ?? '127.0.0.1';
        try {
          await new Promise<void>((resolve) => server.listen(port, host, resolve));
        } catch (e) {
          output.error(`Failed to bind ${host}:${port}: ${e instanceof Error ? e.message : String(e)}`);
          process.exit(1);
        }
        output.section('ProjectMind Dashboard');
        output.kv('URL', `http://${host}:${port}/`);
        output.info('Ctrl+C to stop.');

        process.on('SIGINT', () => {
          server.close();
          process.exit(0);
        });
        await new Promise<never>(() => {});
      });
    });
}

function renderPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>ProjectMind Dashboard</title>
<style>
  :root{color-scheme:dark}
  body{font:14px/1.5 system-ui,sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:24px}
  h1{font-size:18px;margin:0 0 16px} h1 span{color:#58a6ff;font-weight:600}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 16px;min-width:140px}
  .card b{display:block;font-size:22px} .card small{color:#8b949e}
  .grid{display:flex;gap:16px;flex-wrap:wrap} section{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;flex:1;min-width:320px}
  ol{margin:6px 0 0;padding-left:20px} li{margin:2px 0} .score{color:#7ee787;font-family:monospace}
  svg{width:100%;height:auto;background:#0d1117} line.imports{stroke:#1f6feb;stroke-opacity:.55} line.imported-by{stroke:#da3633;stroke-dasharray:3 3;stroke-opacity:.45}
  circle{fill:#58a6ff;stroke:#0d1117} text{fill:#8b949e;font-size:9px}
  #err{color:#f85149;display:none;margin-top:10px}
</style></head><body>
<h1>🧠 <span>ProjectMind</span> · live knowledge graph</h1>
<div class="cards" id="cards"><div class="card">Loading…</div></div>
<div class="grid">
  <section id="rankSec" style="display:none"><h3 style="margin:0 0 6px">PageRank · critical files</h3><ol id="rank"></ol></section>
  <section id="mapSec" style="display:none"><h3 style="margin:0 0 6px">Graph mini-map (top hub neighborhood)</h3>
    <svg viewBox="0 0 800 420" preserveAspectRatio="xMidYMid meet" id="svg"></svg></section>
</div>
<p id="err"></p>
<script>
const err = m => { const e=document.getElementById('err'); e.style.display='block'; e.textContent=m; };
(async () => {
  try {
    const [s, g] = await Promise.all([
      fetch('/api/summary').then(r=>r.json()),
      fetch('/api/graph').then(r=>r.json()),
    ]);
    document.getElementById('cards').innerHTML = [
      ['Graph nodes', g.stats?.totalNodes ?? '–'],
      ['Import edges', g.stats?.totalEdges ?? '–'],
      ['Components', g.stats?.connectedComponents ?? '–'],
      ['Debt items', s.debt?.totalItems ?? '–'],
      ['High severity', s.debt?.high ?? 0],
    ].map(([k,v])=>'<div class="card"><small>'+k+'</small><b>'+v+'</b></div>').join('');
    const rank = document.getElementById('rank');
    rank.innerHTML = (g.pageRank||[]).slice(0,10).map(r=>'<li>'+r.path+' <span class="score">'+r.score+'</span></li>').join('');
    document.getElementById('rankSec').style.display='block';
    // Circle-layout mini map
    const nodes = (g.pageRank||[]).slice(0,16); const idx = new Map(nodes.map((n,i)=>[n.path,i]));
    const cx=400, cy=210, R=160;
    const pos = i => { const a = -Math.PI/2 + i*2*Math.PI/Math.max(1,nodes.length); return [cx+R*Math.cos(a), cy+R*Math.sin(a)]; };
    let svg = '';
    for (const e of (g.edges||[])) {
      const i=idx.get(e.from), j=idx.get(e.to); if(i===undefined||j===undefined) continue;
      const [x1,y1]=pos(i),[x2,y2]=pos(j);
      svg += '<line class="'+(e.type==='imports'?'imports':'imported-by')+'" x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'"/>';
    }
    nodes.forEach((n,i)=>{ const [x,y]=pos(i); const r=6+14*Math.min(1,n.score*40);
      svg += '<circle cx="'+x+'" cy="'+y+'" r="'+r+'"/>';
      svg += '<text x="'+(x+r+2)+'" y="'+(y+3)+'">'+n.path.split('/').pop().slice(0,22)+'</text>'; });
    document.getElementById('svg').innerHTML = svg;
    document.getElementById('mapSec').style.display='block';
  } catch (e) { err('API error: ' + e.message); }
})();
</script></body></html>`;
}
