import { execSync } from 'node:child_process';
import { getStatement } from '../../storage/database.js';
import { ImpactPredictor } from '../../core/predictive/impact-predictor.js';
import { DEFAULT_PREDICTOR_CONFIG } from '../../core/predictive/config.js';
import { isRiskAtOrAbove } from '../../core/predictive/risk-levels.js';
import type { RiskLevel } from '../../core/predictive/risk-levels.js';
import { loadConfig } from '../utils/shared.js';
import { join } from 'node:path';

export interface GateResult {
  name: string;
  passed: boolean;
  detail: string;
}

export async function runGates(
  minGenome: number,
  impactRiskThreshold: RiskLevel = 'high',
  skipImpactCheck: boolean = false,
  allowBreakingApi: boolean = false,
): Promise<GateResult[]> {
  const gates: GateResult[] = [];

  // Gate 1: no high-severity debt items open.
  let highDebt = -1;
  try {
    const row = getStatement(
      `SELECT COUNT(*) AS c FROM debt_items WHERE severity='high' AND resolved=0`,
    ).get() as { c: number } | undefined;
    highDebt = row?.c ?? 0;
  } catch {
    try {
      const row = getStatement(
        `SELECT COUNT(*) AS c FROM debt_items WHERE severity='high'`,
      ).get() as { c: number } | undefined;
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
    const row = getStatement(
      `SELECT COUNT(*) AS c FROM debt_items WHERE type='architectural_drift'`,
    ).get() as { c: number } | undefined;
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
    const row = getStatement(
      'SELECT coherence_score FROM project_genome ORDER BY computed_at DESC, id DESC LIMIT 1',
    ).get() as { coherence_score: number } | undefined;
    genomeScore = row ? Number(row.coherence_score) : null;
  } catch {
    genomeScore = null;
  }
  gates.push({
    name: `Genome ≥ ${minGenome}%`,
    passed: genomeScore !== null && genomeScore >= minGenome / 100,
    detail:
      genomeScore === null
        ? 'no genome snapshot yet (run "pm genome")'
        : `${Math.round(genomeScore * 100)}%`,
  });

  // Gate 4: Impact risk check with configurable threshold.
  // When skipImpactCheck is true, the gate is bypassed entirely.
  let impactRiskPassed = true;
  let impactRiskDetail = 'no staged files';

  if (skipImpactCheck) {
    impactRiskPassed = true;
    impactRiskDetail = 'impact check skipped';
  } else {
    try {
      // Determine project root for the git command to avoid CWD-dependent behavior.
      const projectRoot = loadConfig().projectRoot || process.cwd();
      const staged = execSync('git diff --cached --name-only --diff-filter=ACM', {
        encoding: 'utf8',
        timeout: 5000,
        cwd: projectRoot,
      })
        .trim()
        .split('\n')
        .filter((f) => f.length > 0);

      // Filter to TypeScript/JavaScript files to reduce overhead
      const codeFiles = staged.filter(
        (f) => f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.tsx') || f.endsWith('.jsx'),
      );

      if (codeFiles.length > 0) {
        const predictor = new ImpactPredictor(DEFAULT_PREDICTOR_CONFIG);

        // Track failures per file for detailed reporting
        const fileFailures: Array<{
          filePath: string;
          failures: Array<{
            functionName: string;
            riskLevel: RiskLevel;
            confidence: number;
            reason: string;
          }>;
        }> = [];

        for (const file of codeFiles) {
          try {
            const failures = predictor.predictTestBreaks({
              filePath: file,
              moduleName:
                file
                  .split('/')
                  .pop()
                  ?.replace(/\.[^.]+$/, '') || file,
              changeType: 'modify',
              crossModule: true,
            });

            // Filter failures at or above threshold
            const significantFailures = failures
              .filter((f) => f.riskLevel && isRiskAtOrAbove(f.riskLevel, impactRiskThreshold))
              .map((f) => ({
                functionName: f.functionName,
                riskLevel: (f.riskLevel || 'low') as RiskLevel,
                confidence: f.confidence,
                reason: f.reason,
              }));

            if (significantFailures.length > 0) {
              fileFailures.push({ filePath: file, failures: significantFailures });
            }
          } catch {
            // ignore errors on individual files (e.g. binary, unreadable)
          }
        }

        const filesAtRisk = fileFailures.length;
        if (filesAtRisk > 0) {
          impactRiskPassed = false;
          // Build detailed message
          const lines: string[] = [];
          lines.push(
            `❌ Impact Risk Gate Failed (${filesAtRisk}/${codeFiles.length} files at risk)`,
          );
          for (const { filePath, failures } of fileFailures) {
            const riskLevel = failures[0].riskLevel;
            lines.push(`- ${filePath}: ${failures.length} ${riskLevel}-risk failure(s)`);
            for (const f of failures) {
              lines.push(
                `  - ${f.functionName}: ${f.reason} (confidence: ${f.confidence.toFixed(2)})`,
              );
            }
          }
          lines.push('');
          lines.push('Suggested Actions:');
          for (const { filePath } of fileFailures) {
            lines.push(`- Review changes with \`pm impact --file ${filePath}\``);
          }
          lines.push('- Update mocks or tests as needed.');
          lines.push(
            '- Consider lowering the threshold with --impact-risk-threshold low if appropriate.',
          );
          impactRiskDetail = lines.join('\n');
        } else {
          impactRiskDetail = `no ≥${impactRiskThreshold} risk in ${codeFiles.length} staged file(s)`;
        }
      } else {
        impactRiskDetail = 'no staged code files to analyze';
      }
    } catch (error) {
      // Fail closed: if we can't determine staged files, we cannot verify safety.
      // Report as failed with an actionable message.
      impactRiskPassed = false;
      impactRiskDetail = `could not determine staged files (${error instanceof Error ? error.message : String(error)}) — resolve git state or use --skip-impact-check`;
    }
  }

  gates.push({
    name: `Impact risk (≥${impactRiskThreshold})`,
    passed: impactRiskPassed,
    detail: impactRiskDetail,
  });

  // Gate 5: API surface compatibility check
  let apiSurfacePassed = true;
  let apiSurfaceDetail = 'no staged code files to analyze';

  if (allowBreakingApi) {
    apiSurfacePassed = true;
    apiSurfaceDetail = 'API surface check skipped (--allow-breaking-api)';
  } else {
    try {
      const projectRoot = loadConfig().projectRoot || process.cwd();

      const staged = execSync('git diff --cached --name-only --diff-filter=ACM', {
        encoding: 'utf8',
        timeout: 5000,
        cwd: projectRoot,
      })
        .trim()
        .split('\n')
        .filter((f) => f.length > 0);

      const codeFiles = staged.filter(
        (f) => f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.tsx') || f.endsWith('.jsx'),
      );

      if (codeFiles.length > 0) {
        const { extractApiSurface, getApiAtRef, computeDiff } =
          await import('./api-surface-utils.js');

        const stagedFiles = codeFiles.map((f) => ({
          path: join(projectRoot, f),
          relativePath: f.replace(/\\/g, '/'),
        }));

        const currentApi = await extractApiSurface(stagedFiles, projectRoot);
        const baseApi = await getApiAtRef('HEAD~1', projectRoot);

        if (baseApi.length > 0) {
          const diff = computeDiff(baseApi, currentApi);

          if (diff.breaking.length > 0) {
            apiSurfacePassed = false;
            const lines: string[] = [];
            lines.push(`❌ API Surface Gate Failed (${diff.breaking.length} breaking change(s))`);
            lines.push('Breaking changes detected:');
            for (const sym of diff.breaking.slice(0, 10)) {
              lines.push(`- ${sym.name} (${sym.relativePath}) - ${sym.type}`);
            }
            if (diff.breaking.length > 10) {
              lines.push(`... and ${diff.breaking.length - 10} more breaking changes`);
            }
            lines.push('');
            lines.push('Suggested Actions:');
            lines.push('- Review API changes with `pm api-surface --base HEAD~1`');
            lines.push('- Use --allow-breaking-api to bypass this gate if intentional');
            lines.push('- Consider semantic version bump (major) for breaking changes');
            apiSurfaceDetail = lines.join('\n');
          } else {
            apiSurfaceDetail = `no breaking API changes in ${codeFiles.length} staged file(s)`;
          }
        } else {
          apiSurfaceDetail = 'no base API reference (first commit or no HEAD~1)';
          apiSurfacePassed = true;
        }
      }
    } catch (error) {
      apiSurfacePassed = false;
      apiSurfaceDetail = `could not compute API surface diff (${error instanceof Error ? error.message : String(error)}) — resolve git state or use --allow-breaking-api`;
    }
  }

  gates.push({
    name: 'API surface compatibility',
    passed: apiSurfacePassed,
    detail: apiSurfaceDetail,
  });

  return gates;
}
