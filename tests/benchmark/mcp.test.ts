import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runMcpBenchmark,
  withMcpBenchmarkTimeout,
} from '../../scripts/benchmark/benchmark-mcp.mjs';
import { MCP_CORE_TOOL_NAMES } from '../../src/mcp/tools/guard.js';

type McpBenchmarkResult = Awaited<ReturnType<typeof runMcpBenchmark>>;
type McpObservation = McpBenchmarkResult['observations'][number];

describe('MCP benchmark harness', () => {
  it('reports every registered core tool and does not fabricate skipped invocations', async () => {
    const result = await runMcpBenchmark({} as never);
    expect(result.registeredTools).toBe(MCP_CORE_TOOL_NAMES.length);
    expect(result.schemaComplete).toBe(MCP_CORE_TOOL_NAMES.length);
    expect(result.annotationComplete).toBe(MCP_CORE_TOOL_NAMES.length);
    expect(result.observations).toHaveLength(MCP_CORE_TOOL_NAMES.length);
    expect(result.skippedTools + result.measuredTools).toBe(MCP_CORE_TOOL_NAMES.length);
    expect(result.invocationTimeoutMs).toBe(10_000);
    expect(result.budgetExceededTools).toBe(0);
    expect(result.limitations.length).toBeGreaterThan(1);
    expect(result.tokenizer.mode).toBe('heuristic');
    expect(
      result.observations.every(
        (observation: McpObservation) => observation.budget.maxOutputBytes > 0,
      ),
    ).toBe(true);
  });

  it('uses maintained source fixtures for required-input local read-only tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-mcp-benchmark-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'probe.ts'),
      'export function benchmarkProbe(): boolean { return true; }\n',
      'utf8',
    );
    const deps = {
      projectRoot: root,
      kg: {
        getAllFiles: () => [
          {
            id: 1,
            path: join(root, 'src', 'probe.ts'),
            relativePath: 'src/probe.ts',
          },
        ],
        getFunctions: () => [{ name: 'benchmarkProbe' }],
        getCurrentProjectId: () => 1,
      },
    } as never;

    const result = await runMcpBenchmark(deps);
    const fixtureObservations = result.observations.filter(
      (observation: McpObservation) => observation.fixtureRationale !== undefined,
    );
    expect(fixtureObservations.length).toBeGreaterThan(10);
    expect(fixtureObservations.every((observation: McpObservation) => observation.measured)).toBe(
      true,
    );
    expect(
      fixtureObservations.every(
        (observation: McpObservation) => observation.inputBytes !== undefined,
      ),
    ).toBe(true);
    expect(
      fixtureObservations.every(
        (observation: McpObservation) => observation.providerInputTokens !== undefined,
      ),
    ).toBe(true);
    expect(
      fixtureObservations.every(
        (observation: McpObservation) => observation.latencySummary?.p95Ms !== undefined,
      ),
    ).toBe(true);
    expect(
      result.observations.find(
        (observation: McpObservation) => observation.tool === 'get_source_range',
      )?.fixtureRationale,
    ).toContain('512 bytes');
  });

  it('bounds a non-cooperative invocation with an explicit timeout', async () => {
    await expect(
      withMcpBenchmarkTimeout(new Promise<never>(() => undefined), 250, 'test_fixture'),
    ).rejects.toThrow('test_fixture');
  });

  it('audits the full registered profile without invoking unsafe parity tools', async () => {
    const result = await runMcpBenchmark({} as never, { profile: 'full' });
    expect(result.profile).toBe('full');
    expect(result.registeredTools).toBeGreaterThan(MCP_CORE_TOOL_NAMES.length);
    expect(result.observations).toHaveLength(result.registeredTools);
    expect(result.schemaComplete).toBe(result.registeredTools);
    expect(result.annotationComplete).toBe(result.registeredTools);
    expect(
      result.observations.some((observation: McpObservation) => observation.tool.startsWith('pm_')),
    ).toBe(true);
    expect(
      result.observations
        .filter((observation: McpObservation) => observation.tool.startsWith('pm_'))
        .every((observation: McpObservation) => !observation.measured && observation.skipReason),
    ).toBe(true);
  }, 60_000);

  it('resolves the process-isolated worker from the script benchmark bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-mcp-isolated-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'probe.ts'), 'export const probe = true;\n', 'utf8');

    const result = await runMcpBenchmark({ projectRoot: root } as never, {
      isolated: true,
      profile: 'core',
      invocationTimeoutMs: 5000,
    });
    expect(result.profile).toBe('core');
    expect(result.registeredTools).toBe(MCP_CORE_TOOL_NAMES.length);
    expect(result.schemaComplete).toBe(MCP_CORE_TOOL_NAMES.length);
    expect(result.annotationComplete).toBe(MCP_CORE_TOOL_NAMES.length);
    expect(result.tokenizer.mode).toBe('heuristic');
  }, 60_000);

  it('rejects an unknown tokenizer mode instead of silently selecting a provider', async () => {
    await expect(
      runMcpBenchmark({} as never, { tokenizerMode: 'unexpected' as never }),
    ).rejects.toThrow(/heuristic|transformers/i);
  });
});
