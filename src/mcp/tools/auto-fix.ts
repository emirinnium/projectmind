import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { AutoFixEngine } from '@/core/refactor/auto-fix.js';
import { confineToProject } from './_shared.js';

/**
 * Real fixer ids supported by the AutoFixEngine (see src/core/refactor/auto-fix.ts).
 * The engine also accepts the literal 'all' to run every fixer in deterministic
 * order; we expose the individual ids here and default to 'all' when none are
 * requested.
 */
export const AUTO_FIXER_IDS = [
  'organize-imports',
  'dedupe-imports',
  'remove-unused-imports',
  'add-return-types',
  'var-to-const',
] as const;

export type AutoFixerId = (typeof AUTO_FIXER_IDS)[number];

/** Input accepted by the auto_fix tool. */
export interface AutoFixArgs {
  filePath: string;
  fixes?: AutoFixerId[];
  apply?: boolean;
}

/** Result of an auto_fix run — mirrors the engine's AutoFixResult shape. */
export interface AutoFixToolResult {
  changed: boolean;
  /** Unified-style line diff (empty when nothing changed). */
  diff: string;
  /** True only when apply:true and at least one fixer wrote to disk. */
  written: boolean;
}

/**
 * Run the AutoFixEngine over a single file, preview-first.
 *
 * - `apply:false` (default) NEVER touches disk — the engine only writes when
 *   `write:true` is passed, so preview mode is guaranteed side-effect free.
 * - `apply:true` persists each requested fixer's output to disk.
 *
 * When `fixes` is omitted (or empty) the engine's native 'all' mode runs every
 * fixer in deterministic order. When specific fixers are requested, each is run
 * in sequence; in apply mode each subsequent fixer reads the previous fixer's
 * written output, so the fixes compose correctly.
 *
 * Pure and dependency-light (only needs `projectRoot`) so it is directly
 * unit-testable, mirroring the evaluateContracts pattern.
 */
export async function runAutoFix(
  deps: McpDependencies,
  args: AutoFixArgs,
): Promise<AutoFixToolResult> {
  const absPath = confineToProject(args.filePath, deps.projectRoot);
  const engine = new AutoFixEngine(deps.projectRoot);
  const apply = args.apply ?? false;
  const fixers: Array<AutoFixerId | 'all'> =
    args.fixes && args.fixes.length > 0 ? args.fixes : ['all'];

  let changed = false;
  let written = false;
  const diffs: string[] = [];

  for (const fixer of fixers) {
    const result = engine.run(fixer, absPath, { write: apply });
    if (result.changed) {
      changed = true;
      if (result.diff) diffs.push(result.diff);
      if (result.written) written = true;
    }
  }

  return {
    changed,
    diff: diffs.join('\n'),
    written,
  };
}

export function registerAutoFixTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'auto_fix',
    {
      title: 'Auto-Fix File (AST-safe)',
      description:
        'Run AST-safe mechanical fixes (organize/dedupe/remove-unused imports, add return types, var-to-const) on a single file. ' +
        'Defaults to PREVIEW: returns a unified line diff without touching disk. Pass apply:true to persist the changes.',
      inputSchema: {
        filePath: z
          .string()
          .describe('Path of the file to fix (relative to project root or absolute in-project)'),
        fixes: z
          .array(z.enum(AUTO_FIXER_IDS))
          .optional()
          .describe('Fixers to run; defaults to all when omitted'),
        apply: z
          .boolean()
          .default(false)
          .describe('When true, write changes to disk; when false (default) only preview the diff'),
      },
    },
    async (args) => {
      try {
        const result = await runAutoFix(deps, {
          filePath: args.filePath,
          fixes: args.fixes,
          apply: args.apply,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );
}
