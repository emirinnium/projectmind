import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { predictMergeRisk } from '@/core/coordination/risk.js';
import type {
  ConflictRisk,
  ConflictRiskInput,
  MergeContentChange,
} from '@/core/coordination/risk.js';

/** Input accepted by the predict_merge_risk tool. */
export interface PredictMergeRiskArgs {
  /** Files I plan to edit (relative paths). */
  myFiles: string[];
  /** Files currently locked by OTHER agents (relative paths). */
  otherHeldFiles: string[];
  /** Optional common-base and proposed content for deterministic comparison. */
  myContentChanges?: MergeContentChange[];
  /** Optional common-base and proposed content for the other agent. */
  otherContentChanges?: MergeContentChange[];
}

/**
 * Predict how likely my planned edits are to collide with files other agents
 * hold locks on. Pure wrapper around the core `predictMergeRisk` engine
 * (blast-radius + dependency-direction heuristic over the knowledge graph,
 * plus optional bounded content comparison) — directly unit-testable without
 * an MCP server, mirroring the evaluateContracts/runAutoFix pattern.
 *
 * The engine is synchronous and read-only: it only queries the knowledge
 * graph (no git, no filesystem writes), so this wrapper is sync too.
 */
export function predictMergeRiskForTool(
  deps: McpDependencies,
  args: PredictMergeRiskArgs,
): ConflictRisk {
  const input: ConflictRiskInput = {
    myFiles: args.myFiles,
    otherHeldFiles: args.otherHeldFiles,
    myContentChanges: args.myContentChanges,
    otherContentChanges: args.otherContentChanges,
  };
  return predictMergeRisk(deps.kg, input);
}

export function registerPredictMergeRiskTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'predict_merge_risk',
    {
      title: 'Predict Merge Risk',
      description:
        'Predict how likely your planned edits are to collide with files other agents hold locks on ' +
        '(blast-radius + dependency-direction heuristic over the knowledge graph). If both agents ' +
        'provide common-base and proposed file contents, it also performs a bounded three-way line-range ' +
        'comparison and reports concrete overlapping edits.\n' +
        'WHEN to call: BEFORE a multi-agent edit — pass the files you plan to change plus the files other ' +
        'agents currently hold locks on, and get a low/medium/high collision risk with human-readable reasons.\n' +
        'Returns { level, score, reasons, note, contentAnalysis }. Read-only: never touches the filesystem or git.',
      inputSchema: {
        myFiles: z
          .array(z.string().trim().min(1).max(1000))
          .max(100)
          .describe('Files you plan to edit (relative paths, e.g. ["src/a.ts"])'),
        otherHeldFiles: z
          .array(z.string().trim().min(1).max(1000))
          .max(100)
          .describe(
            'Files currently locked by OTHER agents (relative paths, e.g. ["src/shared.ts"])',
          ),
        myContentChanges: z
          .array(
            z.object({
              filePath: z.string().trim().min(1).max(1000),
              baseContent: z.string().max(200_000),
              proposedContent: z.string().max(200_000),
            }),
          )
          .max(100)
          .optional()
          .describe('Optional common-base and proposed contents for your files'),
        otherContentChanges: z
          .array(
            z.object({
              filePath: z.string().trim().min(1).max(1000),
              baseContent: z.string().max(200_000),
              proposedContent: z.string().max(200_000),
            }),
          )
          .max(100)
          .optional()
          .describe('Optional common-base and proposed contents for the other agent files'),
      },
    },
    async (args) => {
      try {
        const result = predictMergeRiskForTool(deps, {
          myFiles: args.myFiles,
          otherHeldFiles: args.otherHeldFiles,
          myContentChanges: args.myContentChanges,
          otherContentChanges: args.otherContentChanges,
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
