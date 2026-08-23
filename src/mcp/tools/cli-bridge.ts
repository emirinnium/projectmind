import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';
import { runCliCapture } from './cli-runner.js';

/** Commands that must never be launched through this bridge. */
const BLOCKED_ROOT_COMMANDS = new Set(['mcp', 'init']);

export function registerCliBridgeTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'run_cli',
    {
      title: 'Run ProjectMind CLI',
      description: [
        'Run ANY ProjectMind CLI command programmatically and capture its output.',
        'Escape hatch for capabilities without a dedicated tool (doctor, health,',
        'report, layers, audit, license, sbom, churn, api-surface, dedup, heatmap,',
        'ownership, adr, testgen, docgen, migrate, skill-recommend, context-budget,',
        'contract-test, trace convert/show/clear, refactor-roi, deps-fresh, flags,',
        'secrets-life, onboard, embed ...). Prefer dedicated / pm_* parity tools.',
        'shell disabled; cwd pinned to the active project root.',
      ].join(' '),
      inputSchema: {
        args: z.array(z.string()).min(1).describe(
          'Argument vector AFTER the binary name. Example: ["doctor","scan-health"]. Root command "mcp" is blocked.'
        ),
        timeoutMs: z.number().optional().describe('Kill after this many ms (default 120000)'),
      },
    },
    async (args) => {
      try {
        const argv = args.args.map((a) => String(a));
        if (argv.length === 0 || BLOCKED_ROOT_COMMANDS.has(argv[0])) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `Command "${argv[0] ?? ''}" is not allowed through run_cli.` }) }],
          };
        }
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, `cli:${argv[0]}`);
        }

        const res = await runCliCapture(argv, { timeoutMs: args.timeoutMs });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { ok: res.ok, exitCode: res.exitCode, durationMs: res.durationMs, stdout: res.stdout, stderr: res.stderr },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
            },
          ],
        };
      }
    }
  );
}
