import { z } from 'zod';
import { basename, dirname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { ImpactPredictor } from '../../core/predictive/impact-predictor.js';
import { DEFAULT_PREDICTOR_CONFIG } from '../../core/predictive/config.js';
import type { CodeChange, PredictedFailure } from '../../core/predictive/types.js';
import { getOverallRiskLevel } from '../../core/predictive/risk-levels.js';

/** Input accepted by the predict_impact_risk tool. */
export interface PredictImpactRiskArgs {
  /** File being changed. */
  filePath: string;
  /** Kind of change. */
  changeType?: 'add' | 'modify' | 'delete';
  /** Pre-change file content (defaults to git HEAD version). */
  previousContent?: string;
  /** Maximum predicted failures to return. */
  limit?: number;
}

/**
 * Predict change impact with risk levels — enhanced version of predict_impact
 * that includes riskLevel on each failure and an overall risk assessment.
 */
export function predictImpactForTool(
  deps: McpDependencies,
  args: PredictImpactRiskArgs,
): {
  success: boolean;
  filePath: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  failures: PredictedFailure[];
  failureCount: number;
  error?: string;
} {
  const predictor = new ImpactPredictor(DEFAULT_PREDICTOR_CONFIG, deps.db);
  const change: CodeChange = {
    filePath: args.filePath,
    moduleName: basename(dirname(args.filePath)) || args.filePath,
    changeType: args.changeType ?? 'modify',
    crossModule: false,
    previousContent: args.previousContent,
  };
  const failures = predictor.predictTestBreaks(change).slice(0, args.limit ?? 10);
  return {
    success: true,
    filePath: args.filePath,
    riskLevel: getOverallRiskLevel(failures.map((f) => f.riskLevel ?? 'low')),
    failures,
    failureCount: failures.length,
  };
}

export function registerPredictImpactRiskTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'predict_impact_risk',
    {
      title: 'Predict Impact Risk',
      description:
        'Predict change impact with risk levels (low/medium/high/critical) for each predicted failure.\n' +
        'WHEN to call: BEFORE committing a change, to evaluate the risk level of a planned edit.\n' +
        'Returns predicted failures with riskLevel and an overall risk assessment.',
      inputSchema: {
        filePath: z.string().describe('File being changed'),
        changeType: z
          .enum(['add', 'modify', 'delete'])
          .default('modify')
          .describe('Kind of change'),
        previousContent: z
          .string()
          .optional()
          .describe('Pre-change file content (defaults to git HEAD version)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Maximum predicted failures to return'),
      },
    },
    async (args) => {
      try {
        const result = predictImpactForTool(deps, {
          filePath: args.filePath,
          changeType: args.changeType,
          previousContent: args.previousContent,
          limit: args.limit,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: message }) }],
        };
      }
    },
  );
}
