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

interface ZodLikeSchema {
  safeParse: (value: unknown) => { success: boolean };
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
    expect(parityAnnotations(['deps-fresh'], ['audit'])).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(parityAnnotations(['pr-preview'], ['history'])).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(parityAnnotations(['graph'], ['output'])).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
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
      const schema = registered.inputSchema as ZodLikeSchema;
      expect(schema.safeParse(null).success, `schema accepts null: ${name}`).toBe(false);
      expect(
        registered.handler.toString().length,
        `handler is unexpectedly empty: ${name}`,
      ).toBeGreaterThan(40);

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

    expect(tools.pm_scale.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tools.pm_pr_preview.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tools.pm_deps_fresh.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
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

  it.each([
    ['get_embedding_provider', {}],
    ['generate_embedding', { text: 'contract test', dimension: 8 }],
    ['prove_claim', { claim: 'a claim without source locations' }],
    ['run_cli', { args: ['unknown-command'] }],
  ] as const)('executes a safe interface case for %s', async (name, args) => {
    const server = new McpServer({ name: `safe-${name}`, version: '1.0.0' });
    const deps = {} as unknown as McpDependencies;
    await registerAllTools(server, deps);
    const tool = getRegisteredTools(server)[name];
    const result = await tool.handler(args);
    expect(result).toMatchObject({ content: expect.any(Array) });
    expect(result.content[0]?.type).toBe('text');
  });

  it('exposes every supported embedding provider and reports safe fallback details', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const server = new McpServer({ name: 'embedding-provider-contract-test', version: '1.0.0' });
    const deps = {} as unknown as McpDependencies;
    await registerAllTools(server, deps);
    const tool = getRegisteredTools(server).init_embedding_provider;
    const schema = tool.inputSchema as ZodLikeSchema;

    for (const provider of ['simple', 'openai', 'transformers', 'unixcoder', 'codebert']) {
      expect(schema.safeParse({ provider, dimension: 8 }).success).toBe(true);
    }
    expect(schema.safeParse({ provider: 'unsupported-provider' }).success).toBe(false);
    const generateSchema = getRegisteredTools(server).generate_embedding
      .inputSchema as ZodLikeSchema;
    expect(generateSchema.safeParse({ text: 'ok', dimension: 8 }).success).toBe(true);
    expect(generateSchema.safeParse({ text: 'ok', dimension: 0 }).success).toBe(false);
    expect(generateSchema.safeParse({ text: 'ok', dimension: 1.5 }).success).toBe(false);
    expect(generateSchema.safeParse({ text: 'ok', dimension: 8193 }).success).toBe(false);

    const result = await tool.handler({ provider: 'openai', dimension: 8 });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      success: boolean;
      requestedProvider: string;
      provider: string;
      fellBack: boolean;
      limitations: string[];
    };
    expect(payload.success).toBe(true);
    expect(payload.requestedProvider).toBe('openai');
    expect(payload.provider).toBe('simple');
    expect(payload.fellBack).toBe(true);
    expect(payload.limitations.length).toBeGreaterThan(0);
  });

  it('invokes kg_query feature-map with structured feature and flow evidence', async () => {
    const server = new McpServer({ name: 'feature-map-contract-test', version: '1.0.0' });
    const featureFile = {
      id: 1,
      path: 'C:/project/src/core/auth/token.ts',
      relativePath: 'src/core/auth/token.ts',
    };
    const deps = {
      projectRoot: 'C:/project',
      kg: {
        getGraphTraversal: () => ({}),
        getAllFiles: () => [featureFile],
        getImportsWithDetails: () => [],
      },
    } as unknown as McpDependencies;
    await registerAllTools(server, deps);
    const tools = getRegisteredTools(server);
    const result = await tools.kg_query.handler({ action: 'feature-map', limit: 10 });
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      success: boolean;
      action: string;
      features: Array<{ key: string; files: string[] }>;
      limitations: string[];
      nextAction: string;
    };

    expect(payload.success).toBe(true);
    expect(payload.action).toBe('feature-map');
    expect(payload.features).toEqual([
      {
        key: 'core:auth',
        label: 'Core auth',
        files: ['src/core/auth/token.ts'],
        entryFiles: ['src/core/auth/token.ts'],
        testFiles: [],
        dependencies: [],
        dependents: [],
        confidence: 0.94,
        basis: ['src/core boundary', 'first domain directory under core'],
      },
    ]);
    expect(payload.limitations.length).toBeGreaterThan(1);
    expect(payload.nextAction).toContain('confirm business semantics');
  });
});
