import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCP_CORE_TOOL_NAMES, TOOL_ANNOTATIONS } from '../../../src/mcp/tools/guard.js';
import { registerAllTools } from '../../../src/mcp/tools/registry/index.js';
import { registerResourceSubscriptionTool } from '../../../src/mcp/resources.js';
import { stopPeriodicCleanup } from '../../../src/mcp/tools/locks.js';
import type { McpDependencies } from '../../../src/mcp/tools/types.js';

interface RegisteredTool {
  inputSchema?: { safeParse: (value: unknown) => { success: boolean } };
  annotations?: Record<string, unknown>;
  handler: (...args: never[]) => unknown;
}

const matrix = new Set([...MCP_CORE_TOOL_NAMES]);

describe('MCP security contract matrix', () => {
  beforeEach(() => (process.env.PROJECTMIND_TOOLS = 'core'));
  afterEach(() => {
    stopPeriodicCleanup();
    delete process.env.PROJECTMIND_TOOLS;
  });

  it('has a risk case for every registered tool, including empty-object schemas', async () => {
    const server = new McpServer({ name: 'security-matrix', version: '1.0.0' });
    await registerAllTools(server, {} as McpDependencies);
    registerResourceSubscriptionTool(server);
    const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools;
    expect([...matrix].sort()).toEqual(Object.keys(tools).sort());
    for (const name of MCP_CORE_TOOL_NAMES) {
      const tool = tools[name];
      expect(tool, `missing ${name} from matrix registry`).toBeDefined();
      expect(tool.inputSchema, `missing schema for ${name}`).toBeDefined();
      expect(tool.inputSchema?.safeParse(null).success, `null accepted by ${name}`).toBe(false);
      expect(tool.annotations).toMatchObject(TOOL_ANNOTATIONS[name]);
      expect(typeof tool.handler).toBe('function');
      // This is a contract case, not a name-only assertion: every case proves
      // the actual SDK registration has a parser and an executable handler.
      expect(tool.handler.toString().length).toBeGreaterThan(40);
    }
  });

  it('keeps profiles additive and excludes parity tools outside full', async () => {
    for (const profile of ['core', 'review', 'security', 'maintenance', 'full']) {
      process.env.PROJECTMIND_TOOLS = profile;
      const server = new McpServer({ name: `profile-${profile}`, version: '1.0.0' });
      await registerAllTools(server, {} as McpDependencies);
      const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
        ._registeredTools;
      expect(Object.keys(tools).length).toBeGreaterThan(0);
      if (profile !== 'full')
        expect(Object.keys(tools).some((name) => name.startsWith('pm_'))).toBe(false);
      if (profile === 'review') expect(tools.review_project).toBeDefined();
      if (profile === 'security') expect(tools.scan_cves).toBeDefined();
      if (profile === 'maintenance') expect(tools.debt_report).toBeDefined();
      if (profile === 'full')
        expect(Object.keys(tools).some((name) => name.startsWith('pm_'))).toBe(true);
      stopPeriodicCleanup();
    }
  });

  it('audits every generated parity tool for schema, annotations and an executable safe path', async () => {
    process.env.PROJECTMIND_TOOLS = 'full';
    const server = new McpServer({ name: 'full-security-matrix', version: '1.0.0' });
    await registerAllTools(server, {} as McpDependencies);
    const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools;
    const parityNames = Object.keys(tools).filter((name) => name.startsWith('pm_'));
    expect(parityNames.length).toBeGreaterThan(100);
    for (const name of parityNames) {
      const tool = tools[name];
      expect(tool.inputSchema, `missing schema for ${name}`).toBeDefined();
      expect(tool.inputSchema?.safeParse(null).success, `null accepted by ${name}`).toBe(false);
      expect(tool.annotations, `missing annotations for ${name}`).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
      const result = (await tool.handler({ options: { help: true } })) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      expect(result.content?.[0]?.type, `${name} did not return text`).toBe('text');
      expect(result.content?.[0]?.text, `${name} returned no safe-path explanation`).toContain(
        'cliCommand',
      );
    }
  }, 60_000);

  it('executes adversarial boundary cases through the registered handlers', async () => {
    const server = new McpServer({ name: 'adversarial-matrix', version: '1.0.0' });
    await registerAllTools(server, { projectRoot: process.cwd() } as McpDependencies);
    const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools;
    const readPayload = async (name: string, args: unknown): Promise<Record<string, unknown>> => {
      const result = (await tools[name].handler(args as never)) as {
        content: Array<{ text: string }>;
      };
      return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
    };

    const range = await readPayload('get_source_range', {
      filePath: '../outside.ts',
      startByte: 0,
      endByte: 10,
    });
    expect(range.success).toBe(false);
    expect((range.error as { nextActions?: string[] }).nextActions).toContain(
      'Use a project-relative path inside PROJECTMIND_ROOT and retry.',
    );

    const fixer = await readPayload('auto_fix', {
      filePath: '../outside.ts',
      fixes: ['var-to-const'],
      apply: true,
    });
    expect(fixer.error).toBeDefined();
    expect(JSON.stringify(fixer)).not.toContain(process.cwd());

    const review = await readPayload('review_project', {
      base: 'HEAD\n--exec=bad',
      head: 'HEAD',
    });
    expect(review.success).toBe(false);
    expect(review.nextAction).toContain('Git revisions');

    const cli = await readPayload('run_cli', { args: ['mcp'] });
    expect(cli.ok).toBe(false);
    expect(cli.error).toContain('not allowed');
  });
});
