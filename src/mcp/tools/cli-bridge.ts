import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';
import { runCliCapture } from './cli-runner.js';
import { isBlockedCliInvocation } from './guard.js';

/**
 * CLI commands that are safe to run through run_cli (read-only, non-destructive).
 */
export const ALLOWLISTED_CLI_COMMANDS = new Set([
  'doctor',
  'health',
  'report',
  'genome',
  'scale',
  'layers',
  'audit',
  'license',
  'sbom',
  'churn',
  'api-surface',
  'dedup',
  'heatmap',
  'ownership',
  'test-quality',
  'context-budget',
  'pr-preview',
  'flags',
  'skill-recommend',
  'deps-fresh',
  'secrets-life',
]);

/**
 * Per-root SUBCOMMAND whitelist (default-deny).
 *
 * Key = allowlisted root command; value = the EXACT argument-vector prefixes
 * (argv[1..]) that are permitted. Subcommands of a root MUST appear in this
 * list to pass `validateCliCommand` — anything else is rejected with `false`.
 *
 * Examples:
 *   doctor:  only `scan-health` is allowed via run_cli. The mutating
 *            diagnostics (`fix-imports`, `clean-debt`) and `rebuild-index`
 *            (already blacklisted in guard.ts) never reach the CLI.
 *   license: `check` / `report` are the only read-only subcommands.
 *
 * A root WITHOUT an entry here is treated as flag-only: it accepts a bare
 * invocation (no arguments) or arguments that ALL start with `-` (flags).
 * Subcommand-like tokens (`clone`, `delete`, ...) are rejected outright.
 */
const SUBCOMMAND_WHITELIST: Record<string, ReadonlyArray<ReadonlyArray<string>>> = {
  doctor: [['scan-health']],
  license: [['check'], ['report']],
};

/**
 * True when the argument vector is a well-formed flag sequence: every token
 * is a flag (`-...`) OR the immediate VALUE of the preceding flag
 * (e.g. `--format json`, `--since 30`). Subcommand-like tokens (`clone`,
 * `delete`, `scan`, ...) on a flag-only root never satisfy this, so they are
 * rejected by the whitelist.
 */
function isFlagSequence(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) continue;
    // Non-flag token: allowed only as the value of an immediately preceding flag.
    if (i === 0 || !args[i - 1].startsWith('-')) return false;
  }
  return true;
}

/**
 * Whitelist validation for run_cli argument vectors (default-deny).
 *
 * Returns true ONLY when:
 *  1. the root command is in ALLOWLISTED_CLI_COMMANDS, AND
 *  2. the invocation is not blocked by the destructive guard (defense in
 *     depth — isBlockedCliInvocation keeps blocking `mcp`/`init` roots and
 *     destructive subcommands such as `project delete` or `layers --auto-fix`),
 *     AND
 *  3. the remaining arguments match the root's whitelist policy:
 *       - root has a SUBCOMMAND_WHITELIST entry  -> argv must match one of the
 *         listed patterns; extra trailing arguments must form a flag sequence;
 *       - root is flag-only                      -> bare, or the arguments form
 *         a flag sequence.
 *
 * Anything else (unknown root, unknown subcommand, subcommand-like token on a
 * flag-only root) returns false — the invocation is NOT executed.
 */
export function validateCliCommand(argv: string[]): boolean {
  if (argv.length === 0) return false;

  // 1) Root whitelist — default-deny at the root level.
  if (!ALLOWLISTED_CLI_COMMANDS.has(argv[0])) return false;

  // 2) Destructive/restricted invocation guard (mcp/init roots, mutating
  //    subcommands, layers --auto-fix, ...) — defense in depth.
  if (isBlockedCliInvocation(argv)) return false;

  const rest = argv.slice(1);

  // 3a) Root with an explicit subcommand whitelist.
  const patterns = SUBCOMMAND_WHITELIST[argv[0]];
  if (patterns) {
    if (rest.length === 0) return true; // bare root invocation
    for (const p of patterns) {
      if (rest.length >= p.length && p.every((v, i) => rest[i] === v)) {
        // Pattern matched; any EXTRA trailing arguments must form a flag sequence.
        return isFlagSequence(rest.slice(p.length));
      }
    }
    return false;
  }

  // 3b) Flag-only root: bare invocation, or a well-formed flag sequence.
  return isFlagSequence(rest);
}

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
        'BLOCKED: root commands "mcp"/"init" plus destructive subcommands',
        '(project delete, debt clear*, data-flow clear, trace clear, doctor rebuild-index).',
      ].join(' '),
      inputSchema: {
        args: z.array(z.string()).min(1).describe(
          'Argument vector AFTER the binary name. Example: ["doctor","scan-health"]. Root "mcp"/"init" and destructive subcommands are blocked.'
        ),
        timeoutMs: z.number().optional().describe('Kill after this many ms (default 120000)'),
      },
    },
    async (args) => {
      try {
        const argv = args.args.map((a) => String(a));
        if (!validateCliCommand(argv)) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `Command "${argv.join(' ')}" is not allowed through run_cli (root not allowlisted, subcommand not whitelisted, or blocked as destructive/restricted).` }) }],
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
