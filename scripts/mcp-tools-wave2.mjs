// Wave 2: live MCP smoke for path/import/graph/architecture/project/team tools.
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const proc = spawn(process.execPath, [join(ROOT, 'dist', 'cli.js'), 'mcp'], {
  cwd: ROOT,
  env: { ...process.env, PROJECTMIND_ROOT: ROOT },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
let id = 0;
const pending = new Map();
proc.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line.startsWith('{')) continue;
    try {
      const msg = JSON.parse(line);
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        p(msg);
      }
    } catch {}
  }
});
function request(method, params) {
  return new Promise((resolve) => {
    const mid = ++id;
    const t = setTimeout(() => { pending.delete(mid); resolve({ TIMEOUT: true }); }, 20000);
    pending.set(mid, (m) => { clearTimeout(t); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
  });
}
async function tool(name, args) {
  const res = await request('tools/call', { name, arguments: args });
  if (res.TIMEOUT) return { _timeout: true };
  if (res.error) return { _error: res.error.message };
  try { return JSON.parse(res.result.content[0].text); }
  catch { return { _raw: String(res.result?.content?.[0]?.text || '').slice(0, 60) }; }
}

await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'w2', version: '0' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const out = {};
out.resolve_path = await tool('resolve_path', { importPath: '@/cli/utils/version.js', fromFilePath: 'src/cli.ts' });
out.find_file_by_import = await tool('find_file_by_import', { importPath: './types.js', fromFilePath: 'src/parser/ast/parser.ts' });
out.trace_imports = await tool('trace_imports', { filePath: 'src/cli.ts', maxDepth: 2 });
out.get_dependents = await tool('get_dependents', { filePath: 'src/cli/utils/version.ts' });
out.get_dependency_graph = await tool('get_dependency_graph', { modulePath: 'src/core/cache' });
out.find_circular_deps = await tool('find_circular_deps', {});
out.structural_search = await tool('structural_search', { nodeKind: 'FunctionDeclaration', namePattern: 'stableHash', maxResults: 5 });
out.check_architecture = await tool('check_architecture', { filePath: 'src/cli.ts' });
out.suggest_refactor = await tool('suggest_refactor', { filePath: 'src/cli/commands/mcp.ts' });
await tool('store_team_memory', { scope: 'smoke-w2', key: 'k', value: 'v' });
out.team_get = await tool('get_team_memories', { scope: 'smoke-w2' });
const created = await tool('create_project', { name: 'smoke-w2-' + Date.now(), rootPath: ROOT });
const pid = created.project ? created.project.id : null;
out.switch_project = pid ? await tool('switch_project', { projectId: pid }) : { skipped: true };
out.delete_project = pid ? await tool('delete_project', { projectId: pid }) : { skipped: true };

console.log('\n=== WAVE2 RESULTS ===');
for (const [k, v] of Object.entries(out)) {
  let status;
  if (!v || v._timeout) status = 'TIMEOUT';
  else if (v._error) status = 'ERR: ' + String(v._error).slice(0, 60);
  else if ('success' in v) status = 'success=' + v.success;
  else if ('resolved' in v) status = 'resolved=' + v.resolved;
  else status = 'keys:' + Object.keys(v).slice(0, 5).join(',');
  console.log(k.padEnd(22), status);
}
proc.kill();
process.exit(0);
