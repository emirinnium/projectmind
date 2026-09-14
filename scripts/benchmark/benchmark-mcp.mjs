import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerResourceSubscriptionTool } from '../../dist/mcp/resources.js';
import { registerAllTools } from '../../dist/mcp/tools/registry/index.js';
import { createContextTokenCounter } from '../../dist/core/context/tokenizer.js';
import {
  getMcpProfile,
  getMcpToolBudget,
  MCP_CORE_TOOL_NAMES,
  TOOL_ANNOTATIONS,
} from '../../dist/mcp/tools/guard.js';
import { stopPeriodicCleanup } from '../../dist/mcp/tools/locks.js';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
/**
 * Select one already-indexed source file for safe, read-only benchmark cases.
 * The harness must never invent a path or create a file merely to improve
 * coverage: without an indexed source file, path-based tools remain skipped.
 */
function findBenchmarkSourceFile(deps) {
  try {
    if (!deps.kg || typeof deps.kg.getAllFiles !== 'function') return null;
    const files = deps.kg
      .getAllFiles()
      .filter((file) => SOURCE_EXTENSIONS.has(extname(file.relativePath).toLowerCase()))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    if (files.length === 0) return null;
    if (typeof deps.kg.getFunctions === 'function') {
      for (const source of files) {
        const symbol = deps.kg.getFunctions(source.id)[0]?.name;
        if (symbol) return { path: source.relativePath, symbol };
      }
    }
    return { path: files[0].relativePath };
  } catch {
    return null;
  }
}
/**
 * Return only bounded local read-only inputs. Required-input tools are not
 * benchmarked with empty objects because that measures validation failure,
 * not the tool. Mutating/open-world tools intentionally have no fixture.
 */
function safeBenchmarkFixture(tool, deps, source) {
  const filePath = source?.path;
  const symbol = source?.symbol;
  switch (tool) {
    case 'check_coherence':
      return filePath
        ? {
            input: {
              code: 'export const projectMindBenchmarkProbe = true;\n',
              filePath,
              deep: false,
              includeImports: false,
              includeDependents: false,
            },
            rationale: 'Fast offline coherence check against one indexed source file.',
          }
        : null;
    case 'get_context':
      return filePath
        ? {
            input: {
              filePath,
              limit: 1,
              includeImports: true,
              includeDependents: true,
              includeSimilar: false,
              maxTokens: 512,
            },
            rationale:
              'Bounded graph context for one indexed source file without vector expansion.',
          }
        : null;
    case 'trace_imports':
      return filePath
        ? {
            input: { filePath, maxDepth: 1 },
            rationale: 'One-hop import trace for an indexed source file.',
          }
        : null;
    case 'resolve_import':
      return filePath
        ? {
            input: { importPath: 'node:fs', fromFilePath: filePath },
            rationale: 'Bounded external-module resolution; no filesystem mutation.',
          }
        : null;
    case 'get_dependents':
      return filePath
        ? {
            input: { filePath },
            rationale: 'Reverse-dependency lookup for one indexed source file.',
          }
        : null;
    case 'get_dependency_graph':
      return {
        input: { modulePath: 'src' },
        rationale: 'Bounded graph lookup for the conventional source directory.',
      };
    case 'kg_query':
      return {
        input: { action: 'stats', limit: 5 },
        rationale: 'Read-only graph statistics with bounded output.',
      };
    case 'resolve_path':
      return filePath
        ? {
            input: { importPath: 'node:fs', fromFilePath: filePath },
            rationale: 'Bounded module-resolution probe using an indexed source file.',
          }
        : null;
    case 'find_file_by_import':
      return {
        input: { pattern: 'projectmind' },
        rationale: 'Read-only import-pattern lookup with a bounded literal pattern.',
      };
    case 'check_architecture':
      return filePath
        ? {
            input: { filePath, strict: false, maxMarkers: 20 },
            rationale: 'Non-strict architecture check avoids unbounded marker scanning.',
          }
        : null;
    case 'analyze_impact':
      return filePath
        ? {
            input: { filePath, changeType: 'modify', tests: false },
            rationale: 'Read-only direct/transitive impact lookup for one indexed file.',
          }
        : null;
    case 'suggest_refactor':
      return filePath
        ? {
            input: { filePath, focus: 'complexity' },
            rationale: 'Bounded complexity-only refactor analysis without duplicate expansion.',
          }
        : null;
    case 'get_file_status':
      return filePath
        ? {
            input: { filePath },
            rationale: 'Read-only status lookup for one indexed source file.',
          }
        : null;
    case 'get_resource_flows':
      return {
        input: { qualifiedName: 'projectmind:benchmark' },
        rationale: 'Read-only lookup for a namespaced probe resource.',
      };
    case 'get_embedding_provider':
      return {
        input: {},
        rationale: 'Read-only provider capability query.',
      };
    case 'analyze_taint':
      return filePath
        ? {
            input: { filePath },
            rationale: 'Read-only AST taint analysis for one indexed source file.',
          }
        : null;
    case 'get_team_memories':
      return {
        input: { scope: 'benchmark' },
        rationale: 'Read-only, scope-filtered team-memory lookup.',
      };
    case 'search_team_memories':
      return {
        input: { query: 'benchmark', limit: 1, threshold: 0 },
        rationale: 'Bounded semantic-memory read with one result maximum.',
      };
    case 'search_intent':
      return {
        input: { query: 'project configuration', limit: 3 },
        rationale: 'Bounded local intent-search query; it does not call an external provider here.',
      };
    case 'predict_impact':
      return filePath
        ? {
            input: { filePath, changeType: 'modify', limit: 3 },
            rationale: 'Read-only impact prediction with a bounded result count.',
          }
        : null;
    case 'plan_context_budget':
      return filePath
        ? {
            input: { files: [{ path: filePath, relevanceScore: 0.5 }], budget: 512 },
            rationale: 'One-file context-budget plan with a bounded token budget.',
          }
        : null;
    case 'check_intent_conflicts':
      return filePath
        ? {
            input: { targetFiles: [filePath] },
            rationale: 'Read-only conflict lookup scoped to one indexed source file.',
          }
        : null;
    case 'find_patterns':
      return {
        input: {
          name: 'projectmind-benchmark-pattern',
          targetProjectId: String(
            typeof deps.kg?.getCurrentProjectId === 'function'
              ? deps.kg.getCurrentProjectId()
              : '1',
          ),
          limit: 1,
        },
        rationale: 'Bounded local pattern lookup with a synthetic query only.',
      };
    case 'semantic_search':
      return {
        input: { query: 'project configuration', scope: 'file', limit: 3, threshold: 0.99 },
        rationale: 'Bounded semantic lookup with a strict threshold and no writes.',
      };
    case 'find_symbol_references':
      return filePath && symbol
        ? {
            input: { file: filePath, symbol, max: 20 },
            rationale:
              'Language-service reference lookup for a symbol already present in the index.',
          }
        : null;
    case 'find_symbol_definition':
      return filePath && symbol
        ? {
            input: { file: filePath, symbol },
            rationale: 'Language-service definition lookup for an indexed function symbol.',
          }
        : null;
    case 'suggest_next_files':
      return filePath
        ? {
            input: { relativePath: filePath, task: 'understand project configuration', limit: 3 },
            rationale: 'Bounded next-file ranking for one indexed source file.',
          }
        : null;
    case 'recommend_skills':
      return {
        input: { task: 'understand project configuration and code structure', limit: 3 },
        rationale: 'Deterministic local skill ranking with three recommendations.',
      };
    case 'prove_claim':
      return {
        input: { claim: 'Benchmark checks source freshness only.' },
        rationale: 'Evidence contract probe that deliberately makes no semantic claim.',
      };
    case 'verify_freshness':
      return filePath
        ? {
            input: { filePaths: [filePath], maxFiles: 1 },
            rationale: 'Freshness verification for one indexed source file.',
          }
        : null;
    case 'get_source_range':
      return filePath
        ? {
            input: { filePath, startByte: 0, endByte: 512 },
            rationale: 'Bounded byte-range retrieval capped at 512 bytes.',
          }
        : null;
    case 'get_source_symbol_range':
      return filePath && symbol
        ? {
            input: { filePath, symbol, maxBytes: 2048 },
            rationale: 'Bounded indexed symbol-range retrieval for an existing function.',
          }
        : null;
    case 'review_project':
      return {
        input: { base: 'HEAD', head: 'HEAD' },
        rationale: 'Empty Git diff review probe; it cannot publish findings or write files.',
      };
    case 'get_canonical_example':
      return {
        input: { query: 'project configuration', limit: 3 },
        rationale: 'Bounded source-backed example ranking with three candidates.',
      };
    default:
      return null;
  }
}
function outputBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch (error) {
    void error;
    return 0;
  }
}
function errorText(error) {
  return error instanceof Error ? error.message : 'tool invocation failed';
}
/** Benchmark the registered MCP interface without mutating project source or graph state. */
export async function runMcpBenchmark(deps, options = {}) {
  if (options.isolated) {
    return runMcpBenchmarkIsolated(deps, options);
  }
  const started = performance.now();
  const invocationTimeoutMs = normalizeTimeout(options.invocationTimeoutMs);
  const selectedProfile = options.profile ?? 'core';
  if (
    options.tokenizerMode !== undefined &&
    !['heuristic', 'transformers'].includes(options.tokenizerMode)
  ) {
    throw new Error('MCP benchmark tokenizer mode must be heuristic or transformers.');
  }
  const tokenizer = await createContextTokenCounter({
    mode: options.tokenizerMode ?? 'heuristic',
    model: options.tokenizerModel,
  });
  const previousProfile = process.env.PROJECTMIND_TOOLS;
  process.env.PROJECTMIND_TOOLS = selectedProfile === 'full' ? 'all' : selectedProfile;
  try {
    const server = new McpServer({ name: 'projectmind-benchmark', version: '1.0.0' });
    await registerAllTools(server, deps);
    registerResourceSubscriptionTool(server);
    const tools = server._registeredTools;
    const observations = [];
    const benchmarkSource = findBenchmarkSourceFile(deps);
    let schemaComplete = 0;
    let annotationComplete = 0;
    const benchmarkToolNames =
      selectedProfile === 'core'
        ? [...MCP_CORE_TOOL_NAMES]
        : Object.keys(tools).sort((left, right) => left.localeCompare(right));
    for (const toolName of benchmarkToolNames) {
      const registered = tools[toolName];
      const registeredAnnotations = registered?.annotations;
      const annotation = TOOL_ANNOTATIONS[toolName] ?? {
        readOnlyHint: registeredAnnotations?.readOnlyHint === true,
        destructiveHint: registeredAnnotations?.destructiveHint === true,
        idempotentHint: registeredAnnotations?.idempotentHint === true,
        openWorldHint: registeredAnnotations?.openWorldHint === true,
      };
      const schemaPresent = !!registered?.inputSchema;
      const annotationPresent =
        !!registered?.annotations &&
        ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].every(
          (key) => typeof registered.annotations?.[key] === 'boolean',
        );
      if (schemaPresent) schemaComplete++;
      if (annotationPresent) annotationComplete++;
      const schemaAcceptsEmptyObject = schemaPresent
        ? registered.inputSchema.safeParse({}).success
        : false;
      const observation = {
        tool: toolName,
        annotation,
        budget: getMcpToolBudget(toolName),
        schemaAcceptsEmptyObject,
        measured: false,
      };
      if (!registered) {
        observation.skipReason = 'tool is missing from the core registry';
      } else if (!schemaPresent) {
        observation.skipReason = 'tool has no input schema';
      } else if (
        !annotation.readOnlyHint ||
        annotation.destructiveHint ||
        annotation.openWorldHint
      ) {
        observation.skipReason = 'tool is not a bounded local read-only invocation';
      } else if (observation.budget.latencyClass !== 'fast') {
        observation.skipReason = `tool budget class is ${observation.budget.latencyClass}; use a dedicated isolated benchmark fixture`;
      } else {
        const fixture = safeBenchmarkFixture(toolName, deps, benchmarkSource);
        const invocationInput = fixture?.input ?? (schemaAcceptsEmptyObject ? {} : undefined);
        const parsedInput =
          invocationInput === undefined
            ? { success: false }
            : registered.inputSchema.safeParse(invocationInput);
        if (!parsedInput.success) {
          observation.skipReason = 'the maintained safe fixture no longer matches the input schema';
          observations.push(observation);
          continue;
        }
        if (invocationInput === undefined) {
          observation.skipReason =
            'tool requires explicit input; no fabricated invocation was sent';
          observations.push(observation);
          continue;
        }
        if (fixture) observation.fixtureRationale = fixture.rationale;
        const handlerInput = parsedInput.data ?? invocationInput;
        observation.inputBytes = outputBytes(handlerInput);
        observation.inputTokens = Math.ceil(observation.inputBytes / 4);
        observation.providerInputTokens = await tokenizer.count(JSON.stringify(handlerInput));
        const coldStarted = performance.now();
        try {
          const cold = await withMcpBenchmarkTimeout(
            registered.handler(handlerInput),
            invocationTimeoutMs,
            toolName,
          );
          observation.coldMs = roundMs(performance.now() - coldStarted);
          observation.coldOutputBytes = outputBytes(cold);
          observation.coldOutputTokens = Math.ceil(observation.coldOutputBytes / 4);
          observation.coldProviderOutputTokens = await tokenizer.count(JSON.stringify(cold));
          observation.coldBudgetExceeded =
            observation.coldOutputBytes > observation.budget.maxOutputBytes;
          const warmStarted = performance.now();
          const warm = await withMcpBenchmarkTimeout(
            registered.handler(handlerInput),
            invocationTimeoutMs,
            toolName,
          );
          observation.warmMs = roundMs(performance.now() - warmStarted);
          observation.warmOutputBytes = outputBytes(warm);
          observation.warmOutputTokens = Math.ceil(observation.warmOutputBytes / 4);
          observation.warmProviderOutputTokens = await tokenizer.count(JSON.stringify(warm));
          observation.warmBudgetExceeded =
            observation.warmOutputBytes > observation.budget.maxOutputBytes;
          const latencyValues = [observation.coldMs, observation.warmMs].sort(
            (left, right) => left - right,
          );
          const percentile = (p) =>
            latencyValues[
              Math.min(latencyValues.length - 1, Math.ceil(latencyValues.length * p) - 1)
            ];
          observation.latencySummary = {
            p50Ms: percentile(0.5),
            p95Ms: percentile(0.95),
            p99Ms: percentile(0.99),
          };
          observation.measured = true;
        } catch (error) {
          observation.error = errorText(error);
          observation.skipReason = 'safe invocation failed; inspect the recorded error';
        }
      }
      observations.push(observation);
    }
    const measuredTools = observations.filter((item) => item.measured).length;
    const budgetExceededTools = observations.filter(
      (item) => item.coldBudgetExceeded || item.warmBudgetExceeded,
    ).length;
    return {
      profile: getMcpProfile(),
      registeredTools: Object.keys(tools).length,
      schemaComplete,
      annotationComplete,
      measuredTools,
      budgetExceededTools,
      skippedTools: observations.length - measuredTools,
      invocationTimeoutMs,
      tokenizer: {
        mode: tokenizer.mode,
        model: tokenizer.model,
        limitations: [...tokenizer.limitations],
      },
      durationMs: roundMs(performance.now() - started),
      observations,
      limitations: [
        `Profile ${selectedProfile} includes ${benchmarkToolNames.length} registered tool(s); required-input, mutating, open-world and heavy tools are intentionally not invoked by this safe benchmark.`,
        'Estimated token fields remain bytes/4 for compatibility; provider token fields use the selected tokenizer and exclude transport/system-prompt billing overhead.',
        'Results cover this local process and database state only; they are not cross-machine benchmarks.',
        'Invocation timeout bounds the awaited benchmark response; a non-cooperative handler may still finish in the background.',
        ...(budgetExceededTools > 0
          ? [`${budgetExceededTools} measured tool(s) exceeded their declared output budget.`]
          : []),
      ],
      nextAction:
        measuredTools === 0
          ? 'Provide explicit safe fixtures for required-input read-only tools before comparing latency.'
          : 'Repeat after a cold process and compare the recorded cold/warm values by release.',
    };
  } finally {
    stopPeriodicCleanup();
    if (previousProfile === undefined) delete process.env.PROJECTMIND_TOOLS;
    else process.env.PROJECTMIND_TOOLS = previousProfile;
  }
}
/**
 * Run benchmark code in a disposable child process. This is deliberately an
 * explicit opt-in: the regular benchmark remains fast and in-process, while
 * heavy or non-cooperative handlers can be measured without retaining their
 * timers/listeners in the caller. The child receives only a trusted project
 * root and a numeric timeout through an argument array; no shell is involved.
 */
async function runMcpBenchmarkIsolated(deps, options) {
  const invocationTimeoutMs = normalizeTimeout(options.invocationTimeoutMs);
  const selectedProfile = options.profile ?? 'core';
  const tokenizerMode = options.tokenizerMode ?? 'heuristic';
  const tokenizerModel = options.tokenizerModel;
  const workerPath = join(dirnameOfCurrentModule(), 'benchmark-mcp-worker.mjs');
  if (!existsSync(workerPath)) {
    throw new Error(
      'MCP isolated benchmark worker is unavailable. Run npm run build before using --isolated.',
    );
  }
  const root = resolveProjectRoot(deps.projectRoot);
  const child = spawn(
    process.execPath,
    [
      workerPath,
      '--root',
      root,
      '--timeout',
      String(invocationTimeoutMs),
      '--profile',
      selectedProfile,
      '--tokenizer',
      tokenizerMode,
      ...(tokenizerModel ? ['--tokenizer-model', tokenizerModel] : []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PROJECTMIND_TOOLS: selectedProfile === 'full' ? 'all' : selectedProfile,
        PROJECTMIND_MACHINE: '1',
      },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  return await new Promise((resolve, reject) => {
    const hardTimeout = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP isolated benchmark worker timed out after ${invocationTimeoutMs} ms.`));
    }, isolatedWorkerTimeout(invocationTimeoutMs));
    child.once('error', (error) => {
      clearTimeout(hardTimeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(hardTimeout);
      const output = Buffer.concat(stdout).toString('utf8').trim();
      if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString('utf8').trim().slice(-2000);
        reject(
          new Error(
            `MCP isolated benchmark worker exited with ${signal ? `signal ${signal}` : `code ${code}`}.${diagnostic ? ` ${diagnostic}` : ''}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch (error) {
        reject(
          new Error(
            `MCP isolated benchmark worker returned invalid JSON.${error instanceof Error ? ` ${error.message}` : ''}`,
          ),
        );
      }
    });
  });
}
function dirnameOfCurrentModule() {
  return fileURLToPath(new URL('.', import.meta.url));
}
function resolveProjectRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new Error('MCP isolated benchmark requires a non-empty project root.');
  }
  return projectRoot;
}
function isolatedWorkerTimeout(invocationTimeoutMs) {
  // The worker runs several bounded probes; allow per-tool timeout plus a
  // deterministic startup/cleanup margin without permitting an unbounded
  // child process to survive a failed benchmark.
  return Math.min(300_000, Math.max(30_000, invocationTimeoutMs * 4 + 10_000));
}
function normalizeTimeout(value) {
  if (value === undefined) return 10_000;
  if (!Number.isFinite(value) || value < 250 || value > 60_000) {
    throw new Error('MCP benchmark invocation timeout must be between 250 and 60000 ms.');
  }
  return Math.floor(value);
}
export async function withMcpBenchmarkTimeout(promise, timeoutMs, toolName) {
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`MCP benchmark tool "${toolName}" timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
function roundMs(value) {
  return Math.max(0, Math.round(value * 100) / 100);
}
