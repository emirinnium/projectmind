import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerResourceSubscriptionTool } from '../../src/mcp/resources.js';
import { registerAllTools } from '../../src/mcp/tools/registry/index.js';
import {
  MCP_CORE_TOOL_NAMES,
  TOOL_ANNOTATIONS,
  parityAnnotations,
  type CompleteToolAnnotations,
} from '../../src/mcp/tools/guard.js';
import { stopPeriodicCleanup } from '../../src/mcp/tools/locks.js';
import type { McpDependencies } from '../../src/mcp/tools/types.js';

interface RegisteredToolContract {
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  handler: (...args: never[]) => unknown;
}

interface ServerToolRegistry {
  _registeredTools: Record<string, RegisteredToolContract>;
}

const ANNOTATION_KEYS: Array<keyof CompleteToolAnnotations> = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
];

function getRegisteredTools(server: McpServer): Record<string, RegisteredToolContract> {
  return (server as unknown as ServerToolRegistry)._registeredTools;
}

describe('MCP registered tool contract', () => {
  beforeEach(() => {
    vi.stubEnv('PROJECTMIND_TOOLS', 'core');
  });

  afterEach(() => {
    stopPeriodicCleanup();
    vi.unstubAllEnvs();
  });

  it('keeps the annotation catalog exhaustive and behavior-specific', () => {
    expect(Object.keys(TOOL_ANNOTATIONS).sort()).toEqual([...MCP_CORE_TOOL_NAMES].sort());

    expect(TOOL_ANNOTATIONS.check_coherence).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(TOOL_ANNOTATIONS.scan_cves.openWorldHint).toBe(true);
    expect(TOOL_ANNOTATIONS.run_cli).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(TOOL_ANNOTATIONS.genome_score.readOnlyHint).toBe(false);
    expect(TOOL_ANNOTATIONS.get_context).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(parityAnnotations(['deps-fresh', '--audit'])).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(parityAnnotations(['structural-search', 'replace'])).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });

    for (const name of MCP_CORE_TOOL_NAMES) {
      const annotations = TOOL_ANNOTATIONS[name];
      for (const key of ANNOTATION_KEYS) {
        expect(typeof annotations[key]).toBe('boolean');
      }
    }
  });

  it('registers every core tool with a schema, complete annotations, and a handler', async () => {
    const server = new McpServer({ name: 'registry-contract-test', version: '1.0.0' });
    const deps = {} as unknown as McpDependencies;

    await registerAllTools(server, deps);
    registerResourceSubscriptionTool(server);

    const tools = getRegisteredTools(server);
    expect(Object.keys(tools).sort()).toEqual([...MCP_CORE_TOOL_NAMES].sort());

    for (const name of MCP_CORE_TOOL_NAMES) {
      const registered = tools[name];
      expect(registered, `missing registered tool: ${name}`).toBeDefined();
      expect(registered.inputSchema, `missing input schema: ${name}`).toBeDefined();
      expect(registered.annotations, `missing annotations: ${name}`).toBeDefined();
      expect(typeof registered.handler, `missing handler: ${name}`).toBe('function');

      for (const key of ANNOTATION_KEYS) {
        expect(
          Object.prototype.hasOwnProperty.call(registered.annotations, key),
          `missing ${key} annotation: ${name}`,
        ).toBe(true);
        expect(typeof registered.annotations?.[key], `invalid ${key}: ${name}`).toBe('boolean');
      }
    }
  });

  it('keeps generated CLI-parity registrations fully annotated as well', async () => {
    vi.stubEnv('PROJECTMIND_TOOLS', 'all');
    const server = new McpServer({ name: 'parity-contract-test', version: '1.0.0' });
    const deps = {} as unknown as McpDependencies;

    await registerAllTools(server, deps);
    const tools = getRegisteredTools(server);
    expect(Object.keys(tools).length).toBeGreaterThan(MCP_CORE_TOOL_NAMES.length);

    for (const [name, registered] of Object.entries(tools)) {
      expect(registered.inputSchema, `missing input schema: ${name}`).toBeDefined();
      expect(registered.annotations, `missing annotations: ${name}`).toBeDefined();
      for (const key of ANNOTATION_KEYS) {
        expect(
          Object.prototype.hasOwnProperty.call(registered.annotations, key),
          `missing ${key} annotation: ${name}`,
        ).toBe(true);
        expect(typeof registered.annotations?.[key], `invalid ${key}: ${name}`).toBe('boolean');
      }
    }
  });

  it('exercises a safe MCP invocation and rejects invalid required input at the schema boundary', async () => {
    const server = new McpServer({ name: 'registry-invocation-test', version: '1.0.0' });
    const deps = {} as unknown as McpDependencies;

    await registerAllTools(server, deps);
    registerResourceSubscriptionTool(server);
    const tools = getRegisteredTools(server);

    const subscribeResult = await tools.resource_subscribe.handler({
      resourceId: 'pm://stats',
      clientId: 'contract-test-client',
    });
    expect(subscribeResult).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
    });

    const unsubscribeResult = await tools.resource_unsubscribe.handler({
      resourceId: 'pm://stats',
      clientId: 'contract-test-client',
    });
    expect(unsubscribeResult).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
    });

    const schema = tools.agent_locks.inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ action: 'list' }).success).toBe(false);
    expect(schema.safeParse({ action: 'list', agentName: 'contract-test-agent' }).success).toBe(
      true,
    );
  });
});
