import { readFileSync } from 'node:fs';
import { basename, dirname, relative } from 'node:path';
import { Command } from 'commander';
import { withContext, asyncHandler, output } from '@/cli/utils/shared.js';
import { confineToProject } from '@/mcp/tools/_shared.js';
import { assertProjectPath } from '@/core/security/path-security.js';
import { ImpactPredictor } from '@/core/predictive/impact-predictor.js';
import { DEFAULT_PREDICTOR_CONFIG } from '@/core/predictive/config.js';
import {
  calculateCalibratedRisk,
  collectRiskSignals,
  type CalibratedRiskAssessment,
} from '@/core/predictive/calibrated-risk.js';
import { collectGitChurn } from '@/core/debt/git-churn.js';
import { getChangedFiles } from './pr-preview-engine.js';
import { RISK_ORDER, type RiskLevel } from '@/core/predictive/risk-levels.js';
import {
  calculateRiskCalibration,
  riskCalibrationObservationSchema,
} from '@/core/predictive/calibration-metrics.js';

interface RiskOptions {
  pr?: boolean;
  base: string;
  head: string;
  format: string;
  since: string;
}

interface FileRiskResult {
  filePath: string;
  relativePath: string;
  assessment: CalibratedRiskAssessment;
}

function maxRiskLevel(results: readonly FileRiskResult[]): RiskLevel {
  return results.reduce<RiskLevel>(
    (highest, result) =>
      RISK_ORDER[result.assessment.riskLevel] > RISK_ORDER[highest]
        ? result.assessment.riskLevel
        : highest,
    'low',
  );
}

/**
 * `projectmind risk <file>` / `projectmind risk --pr` — transparent,
 * deterministic risk estimate with an explicit uncertainty interval.
 */
export function createRiskCommand(): Command {
  const command = new Command('risk').description(
    'Estimate change-breakage risk with evidence and uncertainty',
  );

  command
    .command('calibrate <file>')
    .description('Score predicted risk probabilities against labeled historical outcomes')
    .option('--format <format>', 'Output format: text|json', 'text')
    .action(
      asyncHandler(async (file: string, options: { format: string }) => {
        if (options.format !== 'text' && options.format !== 'json') {
          throw new Error(`Invalid --format value: "${options.format}" (expected text|json)`);
        }
        await withContext(async (ctx) => {
          const path = assertProjectPath(file, ctx.config.projectRoot, {
            mustExist: true,
            rejectIgnored: true,
          });
          let parsed: unknown;
          try {
            parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
          } catch (error) {
            throw new Error(
              `Unable to read calibration JSON: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          const raw = Array.isArray(parsed)
            ? parsed
            : parsed && typeof parsed === 'object' && 'observations' in parsed
              ? (parsed as { observations: unknown }).observations
              : undefined;
          if (!Array.isArray(raw)) {
            throw new Error(
              'Calibration JSON must be an array or an object with an observations array.',
            );
          }
          const observations = raw.map((item) => riskCalibrationObservationSchema.parse(item));
          const report = calculateRiskCalibration(observations);
          if (options.format === 'json') {
            output.json({
              source: relative(ctx.config.projectRoot, path).replace(/\\/g, '/'),
              report,
            });
            return;
          }
          output.section('Risk Calibration');
          output.kv('Observations', String(report.observations));
          output.kv('Failures', String(report.failures));
          output.kv('Brier score', String(report.brierScore));
          output.kv('Mean predicted', `${(report.meanPredicted * 100).toFixed(1)}%`);
          output.kv('Observed failure rate', `${(report.observedFailureRate * 100).toFixed(1)}%`);
          for (const bin of report.bins) {
            output.kv(
              `${Math.round(bin.lower * 100)}–${Math.round(bin.upper * 100)}% bin`,
              bin.observations === 0
                ? 'no observations'
                : `${bin.observations} observations; gap=${((bin.absoluteGap ?? 0) * 100).toFixed(1)}%`,
            );
          }
          for (const limitation of report.limitations) output.info(limitation);
        });
      }),
    );

  command
    .argument('[file]', 'File path to assess (required unless --pr is used)')
    .option('--pr', 'Assess files changed between --base and --head')
    .option('--base <ref>', 'Base git revision for --pr', 'HEAD^')
    .option('--head <ref>', 'Head git revision for --pr', 'HEAD')
    .option('--since <days>', 'Git churn window in days', '90')
    .option('--format <format>', 'Output format: text|json', 'text')
    .action(
      asyncHandler(async (file: string | undefined, opts: RiskOptions) => {
        if (!opts.pr && !file)
          throw new Error('Provide <file> or use --pr to assess changed files.');
        if (!['text', 'json'].includes(opts.format)) {
          throw new Error(`Invalid --format value: "${opts.format}" (expected text|json)`);
        }
        const since = Number.parseInt(opts.since, 10);
        if (!Number.isSafeInteger(since) || since <= 0 || since > 3650) {
          throw new Error(`Invalid --since value: "${opts.since}" (expected 1..3650)`);
        }

        await withContext(async (ctx) => {
          const relativeCandidates = opts.pr
            ? await getChangedFiles(opts.base, opts.head, ctx.config.projectRoot)
            : [file!];
          if (relativeCandidates.length === 0) {
            const empty = {
              mode: opts.pr ? 'pr' : 'file',
              base: opts.pr ? opts.base : null,
              head: opts.pr ? opts.head : null,
              files: [],
              summary: { riskLevel: 'low' as const, fileCount: 0 },
              note: 'No source files were found for this risk assessment; no risk claim was made.',
            };
            if (opts.format === 'json') output.json(empty);
            else {
              output.section('Risk Assessment');
              output.info(empty.note);
            }
            return;
          }

          const churn = collectGitChurn(ctx.config.projectRoot, since);
          const predictor = new ImpactPredictor(DEFAULT_PREDICTOR_CONFIG, ctx.db);
          const results: FileRiskResult[] = [];

          for (const candidate of [...new Set(relativeCandidates)].sort()) {
            const absolutePath = confineToProject(candidate, ctx.config.projectRoot);
            const relativePath = relative(ctx.config.projectRoot, absolutePath).replace(/\\/g, '/');
            const change = {
              filePath: absolutePath,
              moduleName: basename(dirname(absolutePath)) || relativePath,
              changeType: 'modify' as const,
              crossModule: false,
            };
            const diff = predictor.simulateDiff(change);
            const signals = collectRiskSignals({
              db: ctx.db,
              graph: ctx.kg,
              projectId: ctx.kg.getCurrentProjectId(),
              projectRoot: ctx.config.projectRoot,
              filePath: absolutePath,
              changedFunctions: diff.changedFunctions.length,
              changedTypes: diff.changedTypes.length,
              churnCommits: churn.get(relativePath)?.count ?? 0,
            });
            results.push({
              filePath: absolutePath,
              relativePath,
              assessment: calculateCalibratedRisk(signals),
            });
          }

          const summary = {
            riskLevel: maxRiskLevel(results),
            fileCount: results.length,
            averageProbability:
              Math.round(
                (results.reduce((sum, result) => sum + result.assessment.probability, 0) /
                  results.length) *
                  10000,
              ) / 10000,
          };
          const payload = {
            mode: opts.pr ? 'pr' : 'file',
            base: opts.pr ? opts.base : null,
            head: opts.pr ? opts.head : null,
            files: results,
            summary,
            note: 'Probability is an estimate; interval and uncertainty must be read with the evidence.',
          };

          if (opts.format === 'json') {
            output.json(payload);
            return;
          }

          output.section('Risk Assessment');
          output.kv('Files', String(summary.fileCount));
          output.kv('Overall risk', summary.riskLevel);
          output.kv('Average probability', `${(summary.averageProbability * 100).toFixed(1)}%`);
          for (const result of results) {
            const assessment = result.assessment;
            output.section(result.relativePath);
            output.kv('Risk', assessment.riskLevel);
            output.kv('Probability', `${(assessment.probability * 100).toFixed(1)}%`);
            output.kv(
              '95% interval',
              `${(assessment.confidenceInterval.lower * 100).toFixed(1)}–${(assessment.confidenceInterval.upper * 100).toFixed(1)}%`,
            );
            output.kv('Status', assessment.status);
            output.kv('Historical outcomes', String(assessment.calibration.observations));
            output.info(
              `Evidence: ${assessment.evidence.length} signal(s); ${assessment.uncertainty.length} limitation(s).`,
            );
          }
          output.info(payload.note);
        });
      }),
    );
  return command;
}
