import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { buildProgram } from '../../cli/program.js';
import { runCliCapture } from './cli-runner.js';

/**
 * CLI-parity generator.
 *
 * Walks the commander tree built by `buildProgram()` and registers one MCP
 * tool per executable CLI command/subcommand (`pm_<name>[_<sub>]`). This
 * guarantees 1:1 tool/command parity FOREVER: any future CLI command shows
 * up as an MCP tool automatically on the next server start.
 *
 * Input contract for generated tools (kept intentionally uniform):
 *   options?: Record<string, string | boolean | number> — long-flag names
 *             WITHOUT '--' (e.g. {"format":"json","deep":true})
 *   args?:    string[]                                  — positional args
 *
 * Execution is delegated to the real CLI via runCliCapture with
 * PROJECTMIND_ROOT pinned, so behavior is byte-identical to the terminal.
 */
const BLOCKED = new Set(['mcp']);

export async function registerCliParityTools(server: McpServer, deps: McpDependencies): Promise<number> {
  let registered = 0;

  const walk = (cmd: import('commander').Command, prefix: string[]): void => {
    const path = [...prefix, cmd.name()].filter(Boolean);
    const hasAction = Boolean((cmd as unknown as { _actionHandler?: unknown })._actionHandler);
    const rootName = path[0];

    if (hasAction && !BLOCKED.has(rootName)) {
      const toolName = 'pm_' + path.join('_').replace(/-/g, '_');
      const longFlags = cmd.options.map((o) => o.long?.slice(2)).filter(Boolean) as string[];
      const positional = cmd.registeredArguments.map((a) => a.name + (a.variadic ? '…' : ''));

      const description = [
        `[CLI parity] projectmind ${path.join(' ')}`,
        cmd.description(),
        positional.length ? `Positional: ${positional.join(', ')}` : '',
        longFlags.length ? `Flags(--${longFlags.join(' --')}): ${cmd.options.map(o => o.description).filter(Boolean).join(' | ')}` : '',
        "Call with options:{\"flag\":value} and args:[...].",
      ].filter(Boolean).join(' — ');

      server.registerTool(
        toolName,
        {
          title: `PM: ${path.join(' ')}`,
          description,
          inputSchema: {
            options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
              .describe(`Long-flag map. Valid keys: ${longFlags.length ? longFlags.map(f=>`--${f}`).join(', ') : '(none)'}`),
            args: z.array(z.string()).optional().describe(positional.length ? `Positional: ${positional.join(', ')}` : 'Positional arguments'),
          },
        },
        async (a: { options?: Record<string, string | number | boolean>; args?: string[] }) => {
          const argv = [...path];
          for (const opt of cmd.options) {
            const key = opt.long?.slice(2);
            if (!key) continue;
            const v = a.options?.[key];
            if (v === undefined || v === false) continue;
            argv.push(opt.long!);
            if (!opt.isBoolean() && typeof v !== 'boolean') argv.push(String(v));
          }
          for (const p of a.args ?? []) argv.push(String(p));

          if (deps.agentName) {
            try { deps.kg.markAgentTouched(argv.filter(x => !x.startsWith('-')).join(' '), deps.agentName); } catch {}
          }

          const res = await runCliCapture(argv, { timeoutMs: 180_000 });
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                cliCommand: `projectmind ${path.join(' ')}`,
                ok: res.ok,
                exitCode: res.exitCode,
                durationMs: res.durationMs,
                stdout: res.stdout,
                stderr: res.stderr,
              }, null, 2),
            }],
          };
        }
      );
      registered++;
    }

    for (const sub of cmd.commands ?? []) walk(sub, path);
  };

  const program = await buildProgram();
  // buildProgram returns a root whose children are the real commands; walk
  // each child so top-level names become pm_<cmd>.
  for (const top of program.commands ?? []) walk(top, []);

  console.info(`[mcp] CLI-parity tools registered: ${registered}`);
  return registered;
}
