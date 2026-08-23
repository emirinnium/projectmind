// Live MCP tool smoke test: spawn server, handshake, exercise key tools.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const CLI = join(ROOT, 'dist', 'cli.js');

const proc = spawn(process.execPath, [CLI, 'mcp'], {
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
    const timer = setTimeout(() => { pending.delete(mid); resolve({ TIMEOUT: true }); }, 20000);
    pending.set(mid, (msg) => { clearTimeout(timer); resolve(msg); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
  });
}

async function tool(name, args) {
  const res = await request('tools/call', { name, arguments: args });
  if (res.TIMEOUT) return { _timeout: true };
  if (res.error) return { _error: res.error.message };
  try {
    const parsed = JSON.parse(res.result.content[0].text);
    return parsed;
  } catch {
    return { _raw: String(res.result.content?.[0]?.text).slice(0, 60) };
  }
}

const results = {};
try {
  const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  results.initialize = init.result ? 'OK' : (init.TIMEOUT ? 'TIMEOUT' : JSON.stringify(init).slice(0, 60));
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  results.scale_report = await tool('scale_report', {});
  const sr = results.scale_report || {};
  results._scale_ok = Number.isFinite(sr.totalFiles);

  results.get_context = await tool('get_context', { filePath: 'src/cli/utils/version.ts' });
  results.check_coherence = await tool('check_coherence', {
    code: 'export function ok(){return 1;}\n', filePath: 'src/smoke-probe.ts', fastOnly: true,
  });
  results._coherence_verdict = results.check_coherence.verdict ?? (results.check_coherence._error || 'missing');

  results.debt_report = await tool('debt_report', {});
  results.memory_store = await tool('store_memory', { scope: 'smoke', key: `probe-${Date.now()}`, value: 'hello' });
  results.memory_get = await tool('get_memory', { scope: 'smoke' });

  results.register_watch = await tool('register_file_watch', { filePath: 'src/cli/utils/version.ts', agentId: 'smoke-bot' });
  results.unregister_watch = await tool('unregister_file_watch', { filePath: 'src/cli/utils/version.ts', agentId: 'smoke-bot' });

  results.generate_embedding = await tool('generate_embedding', { text: 'probe', dimension: 64 });
  const emb = results.generate_embedding;
  results._embedding_len = Array.isArray(emb.embedding) ? emb.embedding.length : (emb._error || emb._timeout || 'missing');

  results.analyze_taint = await tool('analyze_taint', { filePath: 'src/cli/utils/git-churn.ts' });

  results.switch_project_bad = await tool('switch_project', { projectId: 999999 });
} catch (e) {
  results.fatal = e.message;
}

console.log('\n=== SMOKE RESULTS ===');
for (const [k, v] of Object.entries(results)) {
  if (typeof v === 'object' && v !== null && '_timeout' in v) console.log(k.padEnd(20), 'TIMEOUT');
  else if (typeof v === 'object' && v !== null && ('_error' in v)) console.log(k.padEnd(20), 'ERR:', String(v._error).slice(0, 70));
  else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') console.log(k.padEnd(20), v);
  else { const bits=[]; for(const kk of ['success','status','verdict','totalItems','count','error','note','flows','totalFiles']) if(v && typeof v==='object' && kk in v) bits.push(`${kk}=${String(JSON.stringify(v[kk])).slice(0,50)}`); console.log(k.padEnd(20), bits.join(' ')||('keys:'+Object.keys(v??{}).slice(0,4).join(','))); }
}

console.log('\nKey checks:');
console.log('scale totalFiles finite:', results._scale_ok);
console.log('coherence verdict:', results._coherence_verdict);
console.log('embedding length:', results._embedding_len);
console.log('watch register status:', (results.register_watch && JSON.parse(JSON.stringify(results.register_watch)).status) || '?');

proc.kill();
process.exit(0);
