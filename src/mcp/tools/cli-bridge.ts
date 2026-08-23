import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url)); // dist/mcp/tools
const CLI_JS = join(TOOL_DIR, '..', '..', 'cli.js'); // dist/cli.js

/**
 * Commands that must never be launched through this bridge:
 * - 'mcp' would recursively spawn another stdio server on our own stdin/stdout.
 * - 'init' writes interactive config; agents should manage files directly.
 */
const BLOCKED_ROOT_COMMANDS = new Set(['mcp', 'init']);

export function registerCliBridgeTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'run_cli',
    {
      title: 'Run ProjectMind CLI',
      description: [
        'Run ANY ProjectMind CLI command programmatically and capture its output.',
        'This is the escape hatch for capabilities that do not have a dedicated',
        'tool yet (doctor scan-health/clean-debt/rebuild-index/fix-imports, health,',
        'report, layers, audit, license, sbom, churn, api-surface, dedup, heatmap,',
        'ownership, adr, testgen, docgen, migrate, skill-recommend, context-budget,',
        'contract-test generate/run, trace convert/show/events/static-missed/clear,',
        'refactor, refactor-roi, deps-fresh, flags, secrets-life, onboard, embed ...).',
        'Prefer dedicated tools when one exists. Runs with shell disabled and cwd',
        'pinned to the active project root.',
      ].join(' '),
      inputSchema: {
        args: z.array(z.string()).min(1).describe(
          'Argument vector AFTER the binary name. Example: ["doctor","scan-health"] or ["sbom","--format","spdx"]. The root command "mcp" is blocked.'
        ),
        timeoutMs: z.number().optional().describe('Kill the command after this many ms (default 120000)'),
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

        const started = Date.now();
        const { spawn } = await import('node:child_process');
        const child = spawn(process.execPath, [CLI_JS, ...argv], {
          cwd: deps.kg.db && process.env.PROJECTMIND_ROOT ? process.env.PROJECTMIND_ROOT : process.cwd(),
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        });

        let stdout = '';
        let stderr = '';
        const cap = (chunk: string, sink: 'out' | 'err') => {
          if (sink === 'out') stdout += chunk;
          else stderr += chunk;
          if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
          if (stderr.length > 40_000) stderr = stderr.slice(-40_000);
        };
        child.stdout.on('data', (d) => cap(d.toString(), 'out'));
        child.stderr.on('data', (d) => cap(d.toString(), 'err'));

        const code: number | null = await new Promise((resolve) => {
          const t = setTimeout(() => {
            child.kill();
            resolve(-1);
          }, args.timeoutMs ?? 120_000);
          child.on('exit', (c) => {
            clearTimeout(t);
            resolve(c ?? -1);
          });
          child.on('error', () => {
            clearTimeout(t);
            resolve(-2);
          });
        });

        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, `cli:${argv[0]}`);
        }

        const tail = (s: string, n: number): string =>
          s.length > n ? '…' + s.slice(-n) : s;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ok: code === 0,
                  exitCode: code,
                  durationMs: Date.now() - started,
                  stdout: tail(stdout, 8000),
                  stderr: tail(stderr, 2000),
                },
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
              text: JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}
