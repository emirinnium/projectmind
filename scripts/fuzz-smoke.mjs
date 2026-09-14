import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseBenchmarkCorpusManifest } from './benchmark/manifest.mjs';
import { isBlockedCliInvocation } from '../dist/mcp/tools/guard.js';
import {
  createPromptBoundary,
  renderPromptBoundary,
  asUntrustedContent,
} from '../dist/mcp/security/untrusted-content.js';
import { toActionableError } from '../dist/utils/actionable-error.js';
import { validateProjectPath } from '../dist/core/security/path-security.js';
import { confinePathValueFlags } from '../dist/mcp/tools/_shared.js';
import { parseReviewPolicy } from '../dist/core/review/policy.js';
import { SCHEMA_SQL } from '../dist/storage/schema.js';
import { createGraphTraversal } from '../dist/storage/kg/graph-traversal.js';
import { MCP_CORE_TOOL_NAMES } from '../dist/mcp/tools/guard.js';
import { registerAllTools } from '../dist/mcp/tools/registry/index.js';
import { registerResourceSubscriptionTool } from '../dist/mcp/resources.js';
import { stopPeriodicCleanup } from '../dist/mcp/tools/locks.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const root = resolve(process.cwd());
const seedPath = fileURLToPath(new URL('../tests/fuzz/seeds.json', import.meta.url));
const seedData = JSON.parse(readFileSync(seedPath, 'utf8'));
const seed = Number.parseInt(process.env.PROJECTMIND_FUZZ_SEED ?? '20260909', 10) >>> 0;
const iterations = Math.min(
  20_000,
  Math.max(100, Number.parseInt(process.env.PROJECTMIND_FUZZ_ITERATIONS ?? '5000', 10) || 5000),
);

function random(seedState) {
  let state = seedState >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state;
  };
}

const next = random(seed);
const failures = [];

function pick(values) {
  return values[next() % values.length];
}

function assert(condition, message, input) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(input)}`);
}

function runCase(name, input, callback) {
  try {
    callback(input);
  } catch (error) {
    let minimizedInput = input;
    if (typeof input === 'string') {
      let chunkSize = Math.max(1, Math.floor(input.length / 2));
      while (chunkSize > 0 && minimizedInput.length > 1) {
        let reduced = false;
        for (let start = 0; start + chunkSize <= minimizedInput.length; start++) {
          const candidate =
            minimizedInput.slice(0, start) + minimizedInput.slice(start + chunkSize);
          try {
            callback(candidate);
          } catch {
            minimizedInput = candidate;
            reduced = true;
            break;
          }
        }
        if (!reduced) chunkSize = Math.floor(chunkSize / 2);
      }
    }
    failures.push({
      name,
      input,
      minimizedInput,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function pathCase(input) {
  try {
    const result = validateProjectPath(input, root, { allowDirectory: true });
    const rel = relative(root, result.absolutePath);
    assert(rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)), 'path escaped root', input);
  } catch (error) {
    // Rejection is the expected safe behavior for malformed/out-of-root input.
    assert(error?.name === 'PathSecurityError', 'path threw an unexpected error type', input);
  }
}

function boundaryCase(input) {
  const content = asUntrustedContent(input, 'source', { relativePath: 'fuzz.ts' });
  const boundary = createPromptBoundary(content, 'fuzz-nonce');
  const rendered = renderPromptBoundary(boundary);
  assert(rendered.includes('fuzz-nonce'), 'boundary lost its nonce', input);
  assert(rendered.includes('trust=untrusted'), 'boundary lost trust marker', input);
  assert(
    !rendered.includes('PM_UNTRUSTED_END_fuzz-nonce\nPM_UNTRUSTED_END_fuzz-nonce'),
    'boundary duplicated closing marker',
    input,
  );
}

function manifestCase(input) {
  const repository = {
    id: 'fuzz-repo',
    url: 'https://example.com/fuzz-repo',
    commitSha: 'a'.repeat(40),
    license: 'MIT',
    languages: ['typescript'],
  };
  const expectedPath = /\.\.|^[/\\]|^[A-Za-z]:/.test(input) ? input : 'src/index.ts';
  try {
    parseBenchmarkCorpusManifest({
      version: 1,
      name: 'fuzz',
      access: 'fixture',
      repositories: [repository],
      cases: [
        {
          repositoryId: 'fuzz-repo',
          case: { id: 'case', query: 'query', expectedPaths: [expectedPath] },
        },
      ],
    });
    assert(
      !/\.\.|^[/\\]|^[A-Za-z]:/.test(expectedPath),
      'unsafe manifest path was accepted',
      expectedPath,
    );
  } catch (error) {
    assert(error instanceof Error, 'manifest parser threw a non-error value', input);
  }
}

function cliBoundaryCase(input) {
  const argv = ['run_cli', '--output', input];
  const blocked = isBlockedCliInvocation(['mcp']);
  assert(blocked === true, 'blocked root command was not blocked', ['mcp']);
  let rejected = false;
  try {
    confinePathValueFlags(argv, root);
  } catch (error) {
    rejected = true;
    assert(
      error?.name === 'PathEscapesProjectError' || error?.name === 'PathSecurityError',
      'path flag threw an unexpected error type',
      argv,
    );
  }
  let pathIsInside = true;
  try {
    validateProjectPath(input, root, { allowDirectory: true });
  } catch (error) {
    pathIsInside = false;
    assert(
      error?.name === 'PathSecurityError',
      'path validation threw an unexpected error type',
      input,
    );
  }
  if (!pathIsInside) assert(rejected, 'escaping CLI path value was accepted', argv);
}

function actionableCase(input) {
  const result = toActionableError(new Error(input || 'runtime failure'));
  assert(result.nextActions.length > 0, 'actionable error had no recovery step', input);
  assert(typeof result.retryable === 'boolean', 'retryable flag was not boolean', input);
  assert(typeof result.networkRequired === 'boolean', 'network flag was not boolean', input);
}

function parserCase(input) {
  const sourceFile = ts.createSourceFile(
    'fuzz.ts',
    input,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let nodes = 0;
  const visit = (node) => {
    nodes++;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert(Number.isSafeInteger(nodes) && nodes >= 1, 'parser returned an invalid node count', input);
}

function reviewCase(input) {
  try {
    const policy = parseReviewPolicy({
      version: 1,
      mode: 'diff',
      preset: 'precision-first',
      rules: [
        {
          id: 'fuzz-rule',
          severity: 'low',
          message: 'Fuzz rule',
          contains: input || 'legacyApi(',
        },
      ],
    });
    assert(policy.rules.length === 1, 'review policy lost a rule', input);
  } catch (error) {
    assert(error instanceof Error, 'review policy threw a non-error value', input);
  }
}

function graphCase(input) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (1, ?, ?)').run('fuzz', root);
    const insertFile = db.prepare(
      'INSERT INTO files (id, project_id, path, relative_path, language, size_bytes, hash) VALUES (?, 1, ?, ?, ?, ?, ?)',
    );
    insertFile.run(1, resolve(root, 'a.ts'), 'a.ts', 'typescript', input.length, 'a');
    insertFile.run(2, resolve(root, 'b.ts'), 'b.ts', 'typescript', input.length, 'b');
    db.prepare(
      'INSERT INTO imports (file_id, source, resolved, resolved_path) VALUES (1, ?, 1, ?)',
    ).run('./b', 'b.ts');
    const traversal = createGraphTraversal({ db, currentProjectId: 1, projectRoot: root });
    const stats = traversal.getStats();
    const visited = traversal.bfs(1, 2, true).visited;
    assert(stats.totalNodes === 2 && stats.totalEdges === 1, 'graph stats drifted', input);
    assert(visited.length === 2, 'graph traversal missed a bounded node', input);
  } finally {
    db.close();
  }
}

async function mcpRegistryCase() {
  const previousProfile = process.env.PROJECTMIND_TOOLS;
  process.env.PROJECTMIND_TOOLS = 'core';
  try {
    const server = new McpServer({ name: 'fuzz-registry', version: '1.0.0' });
    await registerAllTools(server, {});
    registerResourceSubscriptionTool(server);
    const tools = server._registeredTools;
    for (const name of MCP_CORE_TOOL_NAMES) {
      assert(Boolean(tools[name]), 'MCP core tool disappeared from registry', name);
      assert(Boolean(tools[name].inputSchema), 'MCP tool lost its input schema', name);
      assert(Boolean(tools[name].annotations), 'MCP tool lost its annotations', name);
    }
    return { registered: Object.keys(tools).length };
  } finally {
    stopPeriodicCleanup();
    if (previousProfile === undefined) delete process.env.PROJECTMIND_TOOLS;
    else process.env.PROJECTMIND_TOOLS = previousProfile;
  }
}

try {
  const mcpResult = await mcpRegistryCase();
  console.log(JSON.stringify({ mcpRegistry: mcpResult }, null, 2));
} catch (error) {
  failures.push({
    name: 'mcp-registry',
    input: 'core registry',
    error: error instanceof Error ? error.message : String(error),
  });
}

for (let index = 0; index < iterations; index++) {
  const input = pick([...seedData.paths, ...seedData.snippets, ...seedData.queries]);
  const cases = [
    ['path-boundary', pathCase],
    ['prompt-boundary', boundaryCase],
    ['benchmark-manifest', manifestCase],
    ['cli-boundary', cliBoundaryCase],
    ['actionable-error', actionableCase],
    ['typescript-parser', parserCase],
    ['review-policy', reviewCase],
    ['graph-traversal', graphCase],
  ];
  const [name, callback] = cases[index % cases.length];
  runCase(name, input, callback);
}

const summary = {
  seed,
  iterations,
  cases: iterations,
  failures: failures.length,
  corpusHash: createHash('sha256').update(JSON.stringify(seedData)).digest('hex'),
};
console.log(JSON.stringify(summary, null, 2));

if (failures.length > 0) {
  const artifactDir = resolve(root, 'fuzz-artifacts');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    resolve(artifactDir, `fuzz-${seed}.json`),
    JSON.stringify({ summary, failures: failures.slice(0, 100) }, null, 2),
  );
  process.exitCode = 1;
}
