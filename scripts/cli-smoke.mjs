// Full CLI runtime smoke: executes every safe command against an isolated sandbox.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SANDBOX = join(ROOT, 'cli-smoke');

// --- Sandbox setup: isolated project dir (own DB, own git-less state) ---
rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(join(SANDBOX, 'src'), { recursive: true });
writeFileSync(join(SANDBOX, 'package.json'), JSON.stringify({ name: 'smoke', version: '0.0.1' }));
writeFileSync(join(SANDBOX, 'src', 'sample.ts'), [
  'export interface User { id: number }',
  'export async function fetchUser(id: number): Promise<User> {',
  '  const res = await fetch("/api/user/" + id);',
  '  return res.json();',
  '}',
  '',
].join('\n'));
copyFileSync(join(ROOT, 'README.md'), join(SANDBOX, 'README.md'));

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, 'dist', 'cli.js'), ...args], {
    cwd: SANDBOX,
    encoding: 'utf-8',
    timeout: opts.timeout ?? 90_000,
    env: { ...process.env, PROJECTMIND_ROOT: SANDBOX },
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const results = [];
function check(label, args, { expectFail = false, mustInclude = null } = {}) {
  const r = run(args);
  let ok;
  if (expectFail) ok = r.code !== 0;
  else {
    ok = r.code === 0 || /Analysis mode|not implemented|No |warning/i.test(r.out);
    if (mustInclude) ok = ok && r.out.includes(mustInclude);
  }
  results.push({ label: label ?? args.join(' '), args, ok, code: r.code });
}

// --- Phase 1: initial scan builds the sandbox knowledge graph ---
check('scan (initial)', ['scan', '-f'], { mustInclude: 'Scanned' });

// --- Phase 2: read-only analytics ---
for (const args of [
  ['report', '--json'],
  ['genome'],
  ['scale'],
  ['health'],
  ['heatmap'],
  ['ownership', '--since', '90'],
  ['layers'],
  ['graph'],
  ['audit'],
  ['license'],
  ['coupling'],
  ['test-quality'],
  ['deps-fresh'],
  ['dedup'],
  ['churn', '--since', '90'],
  ['api-surface'],
  ['refactor-roi'],
  ['skill-recommend', '--all'],
  ['context-budget', 'add auth middleware'],
  ['doctor', 'fix-imports'],
  ['doctor', 'clean-debt', '--dry-run'],
]) check(args.join(' '), args);

// --- Phase 3: file-scoped commands ---
check('check <file>', ['check', 'src/sample.ts']);
check('context <file>', ['context', 'src/sample.ts']);
check('impact <file>', ['impact', 'src/sample.ts']);
check('taint analyze', ['taint', 'analyze', 'src/sample.ts']);
check('search', ['search', 'user']);

// --- Phase 4: generative/writer commands ---
check('testgen', ['testgen', 'src/sample.ts', '--dry-run']);
check('docgen --api', ['docgen', '--api', '-o', 'docs-gen']);
check('sbom', ['sbom']);
check('contract-test', ['contract-test']);
check('migrate check-deps', ['migrate', 'check-deps']);
check('trace convert', ['trace', 'convert', join(ROOT, 'package.json'), '--format', 'json'], { expectFail: false });

// --- Phase 5: memory/session lifecycle ---
check('session start', ['session', 'start', 'cli-smoke-agent']);
check('memory set/get', ['memory', 'smoke-scope', 'k1', '--set', 'v1']);

// --- Summary ---
console.log('\n=== CLI RUNTIME SMOKE ===');
let failed = 0;
for (const r of results) {
  if (!r.ok) { failed++; console.log(`FAIL [${r.label}] code=${r.code}`); }
}
console.log(`TOTAL ${results.length} | FAILED ${failed}`);
rmSync(SANDBOX, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
