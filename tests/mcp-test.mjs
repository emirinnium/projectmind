import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverPath = path.join(__dirname, '..', 'dist', 'mcp-server.js');

function sendMessage(child, msg) {
  const data = JSON.stringify(msg);
  child.stdin.write(data + '\n');
}

const child = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: path.join(__dirname, '..'),
});

let output = '';
let stderrOutput = '';

child.stdout.on('data', (data) => {
  output += data.toString();
  process.stderr.write(`[STDOUT] ${data.toString()}`);
});

child.stderr.on('data', (data) => {
  stderrOutput += data.toString();
});

child.on('error', (err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

setTimeout(() => {
  sendMessage(child, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
  });
  setTimeout(() => {
    sendMessage(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  }, 500);
  setTimeout(() => {
    sendMessage(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'scan_project', arguments: { root: '.' } },
    });
  }, 1500);
  setTimeout(() => {
    sendMessage(child, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'scale_report', arguments: {} },
    });
  }, 4500);
  setTimeout(() => {
    child.kill();
    console.log('\n=== Server stderr ===');
    console.error(stderrOutput);
    console.log('\n=== Done ===');
  }, 8000);
}, 300);
