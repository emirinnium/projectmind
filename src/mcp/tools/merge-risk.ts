import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { predictMergeRisk } from '@/core/coordination/risk.js';
import type { ConflictRisk, ConflictRiskInput } from '@/core/coordination/risk.js';

/** Input accepted by the predict_merge_risk tool. */
export interface PredictMergeRiskArgs {
  /** Files I plan to edit (relative paths). */
  myFiles: string[];
  /** Files currently locked by OTHER agents (relative paths). */
  otherHeldFiles: string[];
}

/**
 * Predict how likely my planned edits are to collide with files other agents
 * hold locks on. Pure wrapper around the core `predictMergeRisk` engine
 * (blast-radius + dependency-direction heuristic over the knowledge graph) —
 * directly unit-testable without an MCP server, mirroring the
 * evaluateContracts/runAutoFix pattern.
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
        '(blast-radius + dependency-direction heuristic over the knowledge graph).\n' +
        'WHEN to call: BEFORE a multi-agent edit — pass the files you plan to change plus the files other ' +
        'agents currently hold locks on, and get a low/medium/high collision risk with human-readable reasons.\n' +
        'Returns { level, score, reasons, note }. Read-only: never touches the filesystem or git.',
      inputSchema: {
        myFiles: z
          .array(z.string())
          .describe('Files you plan to edit (relative paths, e.g. ["src/a.ts"])'),
        otherHeldFiles: z
          .array(z.string())
          .describe(
            'Files currently locked by OTHER agents (relative paths, e.g. ["src/shared.ts"])',
          ),
      },
    },
    async (args) => {
      try {
        const result = predictMergeRiskForTool(deps, {
          myFiles: args.myFiles,
          otherHeldFiles: args.otherHeldFiles,
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
