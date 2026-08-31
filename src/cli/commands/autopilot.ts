import { Command } from 'commander';
import { asyncHandler, output, loadConfig, withService } from '@/cli/utils/shared.js';
import { writeFileSync, existsSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { getStatement } from '../../storage/database.js';
import { ImpactPredictor } from '../../core/predictive/impact-predictor.js';
import type { PredictorConfig } from '../../core/predictive/types.js';

/**
 * Agent Autopilot — turns AGENTS.md guidance into ENFORCEMENT.
 *
 * `pm pre-commit`       : quality gate with real exit codes (CI/hook friendly)
 * `pm autopilot install-hooks [--uninstall]` : installs/uninstalls a git
 *   pre-commit hook that runs the gate so no agent (or human) can skip it.
 */

const HOOK_MARKER = 'projectmind-autopilot';

interface GateResult {
  name: string;
  passed: boolean;
  detail: string;
}

function runGates(minGenome: number): GateResult[] {
  const gates: GateResult[] = [];

  // Gate 1: no high-severity debt items open.
  let highDebt = -1;
  try {
    const row = getStatement(`SELECT COUNT(*) AS c FROM debt_items WHERE severity='high' AND resolved=0`).get() as { c: number } | undefined;
    highDebt = row?.c ?? 0;
  } catch {
    try {
      const row = getStatement(`SELECT COUNT(*) AS c FROM debt_items WHERE severity='high'`).get() as { c: number } | undefined;
      highDebt = row?.c ?? 0;
    } catch {
      highDebt = -1;
    }
  }
  gates.push({
    name: 'High-severity debt',
    passed: highDebt === 0,
    detail: highDebt < 0 ? 'debt_items table unavailable' : `${highDebt} open item(s)`,
  });

  // Gate 2: no architectural drift cycles recorded.
  let cycles = -1;
  try {
    const row = getStatement(`SELECT COUNT(*) AS c FROM debt_items WHERE type='architectural_drift'`).get() as { c: number } | undefined;
    cycles = row?.c ?? 0;
  } catch {
    cycles = -1;
  }
  gates.push({
    name: 'Circular dependencies',
    passed: cycles === 0,
    detail: cycles < 0 ? 'unavailable' : `${cycles} cycle finding(s)`,
  });

  // Gate 3: latest genome score above threshold.
  let genomeScore: number | null = null;
  try {
    const row = getStatement('SELECT coherence_score FROM project_genome ORDER BY computed_at DESC, id DESC LIMIT 1').get() as { coherence_score: number } | undefined;
    genomeScore = row ? Number(row.coherence_score) : null;
  } catch {
    genomeScore = null;
  }
  gates.push({
    name: `Genome ≥ ${minGenome}%`,
    passed: genomeScore !== null && genomeScore >= minGenome / 100,
    detail: genomeScore === null
      ? 'no genome snapshot yet (run "pm genome")'
      : `${Math.round(genomeScore * 100)}%`,
  });

  // Gate 4: No critical predicted impact risk in staged files.
  let impactRiskPassed = true;
  let impactRiskDetail = 'no staged files';
  try {
    const staged = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(f => f.length > 0);
    if (staged.length > 0) {
      const predictorConfig: PredictorConfig = {
        bayesianPrior: 0.5,
        crossModuleWeight: 0.8,
        confidenceThreshold: 0.7,
        modelUpdateRate: 0.1,
      };
      const predictor = new ImpactPredictor(predictorConfig);
      let criticalFound = false;
      for (const file of staged) {
        try {
          const failures = predictor.predictTestBreaks({
            filePath: file,
            moduleName: file.split('/').slice(-2)[0] || file,
            changeType: 'modify',
            crossModule: false,
          });
          if (failures.some(f => f.riskLevel === 'critical')) {
            criticalFound = true;
            break;
          }
        } catch {
          // ignore errors on individual files (e.g. binary, unreadable)
        }
      }
      impactRiskPassed = !criticalFound;
      impactRiskDetail = criticalFound
        ? 'critical risk detected in staged files'
        : `no critical risk in ${staged.length} staged file(s)`;
    }
  } catch {
    impactRiskDetail = 'could not determine staged files';
  }
  gates.push({
    name: 'Predicted impact risk (critical)',
    passed: impactRiskPassed,
    detail: impactRiskDetail,
  });

  return gates;
}

export function createAutopilotCommand(): Command {
  const cmd = new Command('autopilot')
    .description('Agent workflow enforcement: pre-commit quality gates and git hook installation');

  cmd
    .command('pre-commit')
    .description('Quality gate for commits/CI: exits 1 when any check fails')
    .option('--min-genome <n>', 'Minimum genome score percent', '70')
    .option('--format <fmt>', 'Output: text|json', 'text')
    .action(asyncHandler(async (opts: { minGenome: string; format: string }) => {
      // withService initializes the DB layer that runGates' statements need.
      await withService(['debt'], async () => {
        const gates = runGates(parseInt(opts.minGenome, 10));
        const failed = gates.filter((g) => !g.passed);
        const allPassed = failed.length === 0;

        if (opts.format === 'json') {
          output.info(JSON.stringify({ ok: allPassed, gates }, null, 2));
        } else {
          output.section('🤖 ProjectMind Pre-Commit Gate');
          for (const g of gates) {
            output.kv(`${g.passed ? '✅' : '❌'} ${g.name}`, g.detail);
          }
          if (!allPassed) {
            output.error(`Gate FAILED — ${failed.length} check(s) must pass before committing.`);
          } else {
            output.success('All gates passed.');
          }
        }

        if (!allPassed) process.exit(1);
      });
    }));

  cmd
    .command('install-hooks')
    .description('Install a git pre-commit hook that enforces "pm autopilot pre-commit"')
    .option('--uninstall', 'Remove the ProjectMind hook instead')
    .action(asyncHandler(async (opts: { uninstall?: boolean }) => {
      const root = loadConfig().projectRoot;
      const hooksDir = join(root, '.git', 'hooks');
      const hookPath = join(hooksDir, 'pre-commit');

      if (opts.uninstall) {
        if (existsSync(hookPath)) {
          const content = readFileSync(hookPath, 'utf-8');
          if (content.includes(HOOK_MARKER)) {
            rmSync(hookPath);
            output.success('ProjectMind pre-commit hook removed.');
          } else {
            output.warn('Existing pre-commit hook is not managed by ProjectMind — leaving it untouched.');
          }
        } else {
          output.info('No pre-commit hook present.');
        }
        return;
      }

      const cliEntry = join(root, 'dist', 'cli.js').replace(/\\/g, '/');
      const script = [
        '#!/bin/sh',
        `# ${HOOK_MARKER} — auto-generated by "pm autopilot install-hooks"`,
        'exec node "' + cliEntry + '" autopilot pre-commit',
        '',
      ].join('\n');

      writeFileSync(hookPath, script);
      try {
        chmodSync(hookPath, 0o755);
      } catch {
        // Windows filesystems may ignore chmod — git still executes the hook.
      }
      output.success(`✓ Pre-commit hook installed at ${hookPath}`);
      output.kv('Gate', 'pm autopilot pre-commit (high-debt, cycles, genome threshold)');
      output.info('Use --uninstall to remove.');
    }));

  return cmd;
}
