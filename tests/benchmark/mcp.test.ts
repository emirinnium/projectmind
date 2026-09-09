import { describe, expect, it } from 'vitest';
import { runMcpBenchmark } from '../../src/cli/commands/benchmark-mcp.js';
import { MCP_CORE_TOOL_NAMES } from '../../src/mcp/tools/guard.js';

describe('MCP benchmark harness', () => {
  it('reports every registered core tool and does not fabricate skipped invocations', async () => {
    const result = await runMcpBenchmark({} as never);
    expect(result.registeredTools).toBe(MCP_CORE_TOOL_NAMES.length);
    expect(result.schemaComplete).toBe(MCP_CORE_TOOL_NAMES.length);
    expect(result.annotationComplete).toBe(MCP_CORE_TOOL_NAMES.length);
    expect(result.observations).toHaveLength(MCP_CORE_TOOL_NAMES.length);
    expect(result.skippedTools + result.measuredTools).toBe(MCP_CORE_TOOL_NAMES.length);
    expect(result.limitations.length).toBeGreaterThan(1);
    expect(result.observations.every((observation) => observation.budget.maxOutputBytes > 0)).toBe(
      true,
    );
  });
});
