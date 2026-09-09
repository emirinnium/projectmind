import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerResourceSubscriptionTool } from '@/mcp/resources.js';
import { registerAllTools } from '@/mcp/tools/registry/index.js';
import { getMcpToolBudget, MCP_CORE_TOOL_NAMES, TOOL_ANNOTATIONS } from '@/mcp/tools/guard.js';
import { stopPeriodicCleanup } from '@/mcp/tools/locks.js';
import type { McpDependencies } from '@/mcp/tools/types.js';

export interface McpToolBenchmarkObservation {
  tool: string;
  annotation: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  budget: {
    latencyClass: 'fast' | 'standard' | 'heavy' | 'external';
    maxOutputBytes: number;
    maxOutputTokens: number;
  };
  schemaAcceptsEmptyObject: boolean;
  measured: boolean;
  skipReason?: string;
  coldMs?: number;
  warmMs?: number;
  coldOutputBytes?: number;
  warmOutputBytes?: number;
  coldOutputTokens?: number;
  warmOutputTokens?: number;
  error?: string;
}

export interface McpBenchmarkResult {
  profile: 'core';
  registeredTools: number;
  schemaComplete: number;
  annotationComplete: number;
  measuredTools: number;
  skippedTools: number;
  durationMs: number;
  observations: McpToolBenchmarkObservation[];
  limitations: string[];
  nextAction: string;
}

function outputBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch (error) {
    void error;
    return 0;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'tool invocation failed';
}

/** Benchmark the registered MCP interface without mutating project source or graph state. */
export async function runMcpBenchmark(deps: McpDependencies): Promise<McpBenchmarkResult> {
  const started = performance.now();
  const previousProfile = process.env.PROJECTMIND_TOOLS;
  process.env.PROJECTMIND_TOOLS = 'core';
  try {
    const server = new McpServer({ name: 'projectmind-benchmark', version: '1.0.0' });
    await registerAllTools(server, deps);
    registerResourceSubscriptionTool(server);
    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            inputSchema?: { safeParse: (value: unknown) => { success: boolean } };
            annotations?: Record<string, unknown>;
            handler: (value: unknown) => Promise<unknown>;
          }
        >;
      }
    )._registeredTools;
    const observations: McpToolBenchmarkObservation[] = [];
    let schemaComplete = 0;
    let annotationComplete = 0;
    for (const toolName of MCP_CORE_TOOL_NAMES) {
      const registered = tools[toolName];
      const annotation = TOOL_ANNOTATIONS[toolName];
      const schemaPresent = !!registered?.inputSchema;
      const annotationPresent =
        !!registered?.annotations &&
        ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].every(
          (key) => typeof registered.annotations?.[key] === 'boolean',
        );
      if (schemaPresent) schemaComplete++;
      if (annotationPresent) annotationComplete++;
      const schemaAcceptsEmptyObject = schemaPresent
        ? registered.inputSchema!.safeParse({}).success
        : false;
      const observation: McpToolBenchmarkObservation = {
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
      } else if (!schemaAcceptsEmptyObject) {
        observation.skipReason = 'tool requires explicit input; no fabricated invocation was sent';
      } else if (
        !annotation.readOnlyHint ||
        annotation.destructiveHint ||
        annotation.openWorldHint
      ) {
        observation.skipReason = 'tool is not a bounded local read-only invocation';
      } else {
        const coldStarted = performance.now();
        try {
          const cold = await registered.handler({});
          observation.coldMs = roundMs(performance.now() - coldStarted);
          observation.coldOutputBytes = outputBytes(cold);
          observation.coldOutputTokens = Math.ceil(observation.coldOutputBytes / 4);
          const warmStarted = performance.now();
          const warm = await registered.handler({});
          observation.warmMs = roundMs(performance.now() - warmStarted);
          observation.warmOutputBytes = outputBytes(warm);
          observation.warmOutputTokens = Math.ceil(observation.warmOutputBytes / 4);
          observation.measured = true;
        } catch (error) {
          observation.error = errorText(error);
          observation.skipReason = 'safe invocation failed; inspect the recorded error';
        }
      }
      observations.push(observation);
    }
    const measuredTools = observations.filter((item) => item.measured).length;
    return {
      profile: 'core',
      registeredTools: Object.keys(tools).length,
      schemaComplete,
      annotationComplete,
      measuredTools,
      skippedTools: observations.length - measuredTools,
      durationMs: roundMs(performance.now() - started),
      observations,
      limitations: [
        'Required-input, mutating and open-world tools are intentionally not invoked by this safe benchmark.',
        'Token values are UTF-8 byte estimates (bytes/4), not provider tokenizer counts.',
        'Results cover this local process and database state only; they are not cross-machine benchmarks.',
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

function roundMs(value: number): number {
  return Math.max(0, Math.round(value * 100) / 100);
}
