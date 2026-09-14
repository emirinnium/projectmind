import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { AutoFixEngine } from '@/core/refactor/auto-fix.js';
import { assertProjectPath } from '@/core/security/path-security.js';
import { actionableMcpError } from '@/utils/actionable-error.js';
import {
  AutoFixFeedbackStore,
  type AutoFixFeedbackValue,
} from '@/core/refactor/autofix-feedback.js';

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
  evidenceAudits?: Array<{
    ledgerRecordId: number;
    ledgerRecordHash: string;
    replayEventId: number;
    replayEventHash: string;
  }>;
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
  const absPath = assertProjectPath(args.filePath, deps.projectRoot, {
    mustExist: true,
    rejectIgnored: true,
  });
  const engine = new AutoFixEngine(deps.projectRoot, {
    db: deps.db,
    projectId: deps.kg?.getCurrentProjectId?.(),
  });
  const apply = args.apply ?? false;
  const fixers: Array<AutoFixerId | 'all'> =
    args.fixes && args.fixes.length > 0 ? args.fixes : ['all'];

  let changed = false;
  let written = false;
  const diffs: string[] = [];
  const evidenceAudits: NonNullable<AutoFixToolResult['evidenceAudits']> = [];

  for (const fixer of fixers) {
    const result = engine.run(fixer, absPath, { write: apply });
    if (result.changed) {
      changed = true;
      if (result.diff) diffs.push(result.diff);
      if (result.written) written = true;
      if (result.evidenceAudit) evidenceAudits.push(result.evidenceAudit);
    }
  }

  return {
    changed,
    diff: diffs.join('\n'),
    written,
    ...(evidenceAudits.length > 0 ? { evidenceAudits } : {}),
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
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );

  server.registerTool(
    'record_autofix_feedback',
    {
      title: 'Record Auto-Fix Feedback',
      description:
        'Record whether a specific auto-fix suggestion was accepted, rejected, or skipped. Only repo-scoped metadata is stored; source content is never persisted.',
      inputSchema: {
        fixer: z.enum(AUTO_FIXER_IDS).describe('Auto-fix identifier'),
        feedback: z
          .enum(['accepted', 'rejected', 'skipped'])
          .describe('Human/agent outcome for the suggestion'),
        agentName: z.string().trim().min(1).max(200).optional().describe('Optional agent profile'),
        sourceHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/i)
          .optional()
          .describe('Optional hash of the source version, never the source content'),
        policyVersion: z.string().trim().min(1).max(100).optional(),
      },
    },
    async (args) => {
      try {
        if (!deps.db) throw new Error('Auto-fix feedback storage is unavailable.');
        const store = new AutoFixFeedbackStore(deps.db, deps.kg.getCurrentProjectId());
        const record = store.record({
          fixer: args.fixer,
          feedback: args.feedback as AutoFixFeedbackValue,
          agentName: args.agentName ?? deps.agentName,
          sourceHash: args.sourceHash,
          policyVersion: args.policyVersion,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, record }, null, 2) }],
        };
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );

  server.registerTool(
    'recommend_autofix',
    {
      title: 'Recommend Auto-Fixers',
      description:
        'Recommend auto-fixers from repo-scoped accept/reject history. Insufficient or mixed evidence is reported instead of being treated as approval.',
      inputSchema: {
        fixers: z.array(z.enum(AUTO_FIXER_IDS)).max(AUTO_FIXER_IDS.length).optional(),
        agentName: z.string().trim().min(1).max(200).optional().describe('Optional agent profile'),
        minimumSamples: z.number().int().min(1).max(100).default(3),
        decayDays: z
          .number()
          .positive()
          .max(3650)
          .optional()
          .describe('Optional half-life for older feedback'),
      },
    },
    async (args) => {
      try {
        if (!deps.db) throw new Error('Auto-fix feedback storage is unavailable.');
        const store = new AutoFixFeedbackStore(deps.db, deps.kg.getCurrentProjectId());
        const recommendations = store.recommend(args.fixers ?? AUTO_FIXER_IDS, {
          agentName: args.agentName ?? deps.agentName,
          minimumSamples: args.minimumSamples,
          decayDays: args.decayDays,
        });
        return {
          content: [
            { type: 'text', text: JSON.stringify({ success: true, recommendations }, null, 2) },
          ],
        };
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );

  server.registerTool(
    'set_autofix_feedback_opt_out',
    {
      title: 'Set Auto-Fix Feedback Preference',
      description:
        'Enable or disable collection of repo-scoped auto-fix outcome metadata for an agent profile.',
      inputSchema: {
        agentName: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('Agent profile; omitted means default scope'),
        optedOut: z.boolean().describe('When true, do not record or use feedback for this scope'),
      },
    },
    async (args) => {
      try {
        if (!deps.db) throw new Error('Auto-fix feedback storage is unavailable.');
        const store = new AutoFixFeedbackStore(deps.db, deps.kg.getCurrentProjectId());
        store.setOptOut(args.agentName ?? deps.agentName, args.optedOut);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { success: true, optedOut: store.isOptedOut(args.agentName ?? deps.agentName) },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );

  server.registerTool(
    'reset_autofix_feedback',
    {
      title: 'Reset Auto-Fix Feedback',
      description:
        'Logically reset auto-fix personalization for an agent scope. Historical rows remain append-only and auditable.',
      inputSchema: {
        agentName: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('Agent profile; omitted means default scope'),
      },
    },
    async (args) => {
      try {
        if (!deps.db) throw new Error('Auto-fix feedback storage is unavailable.');
        const store = new AutoFixFeedbackStore(deps.db, deps.kg.getCurrentProjectId());
        const reset = store.reset(args.agentName ?? deps.agentName);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, reset }, null, 2) }],
        };
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );
}
