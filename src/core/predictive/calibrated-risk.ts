import type { DatabaseSync } from 'node:sqlite';
import type { FileInfo } from '../../storage/kg/types.js';
import { reportSuppressedError } from '../../utils/errors.js';

const CALIBRATION_VERSION = 'structural-beta-v1';
const MINIMUM_CALIBRATION_OBSERVATIONS = 10;

export interface RiskSignals {
  filePath: string;
  indexed: boolean;
  directDependents: number;
  affectedModules: number;
  changedFunctions: number;
  changedTypes: number;
  churnCommits: number;
  debt: {
    high: number;
    medium: number;
    low: number;
  };
  historicalFailures: number;
  historicalObservations: number;
  limitations?: string[];
}

export interface RiskEvidence {
  signal: string;
  value: number | string;
  contribution: number;
  explanation: string;
}

export interface CalibratedRiskAssessment {
  status: 'estimated' | 'insufficient-data';
  probability: number;
  confidenceInterval: { lower: number; upper: number; level: 0.95 };
  confidence: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  calibration: {
    method: 'beta-smoothed-structural-baseline';
    version: string;
    observations: number;
    failures: number;
    minimumObservations: number;
    empiricallyCalibrated: boolean;
  };
  evidence: RiskEvidence[];
  uncertainty: string[];
}

export interface RiskSignalCollectionInput {
  db: DatabaseSync;
  graph: {
    getFileByPath(path: string): FileInfo | null;
    getDependents(fileId: number): FileInfo[];
  };
  projectId: number;
  projectRoot?: string;
  filePath: string;
  changedFunctions?: number;
  changedTypes?: number;
  churnCommits?: number;
}

function clamp(value: number, lower = 0, upper = 1): number {
  return Math.min(upper, Math.max(lower, value));
}

function finiteCount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0;
}

function rounded(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function saturating(value: number, scale: number): number {
  return clamp(finiteCount(value) / scale);
}

/**
 * Compute a transparent, deterministic risk prior and update it with observed
 * failures using a beta posterior. This is deliberately not presented as a
 * trained model: until enough outcomes exist, the interval stays [0, 1] and
 * the result is marked insufficient-data.
 */
export function calculateCalibratedRisk(signals: RiskSignals): CalibratedRiskAssessment {
  const evidence: RiskEvidence[] = [];
  const add = (
    signal: string,
    value: number | string,
    contribution: number,
    explanation: string,
  ): void => {
    evidence.push({ signal, value, contribution: rounded(contribution), explanation });
  };

  const structuralPrior = clamp(
    0.05 +
      saturating(signals.directDependents, 8) * 0.18 +
      saturating(signals.affectedModules, 4) * 0.12 +
      saturating(signals.changedFunctions, 6) * 0.12 +
      saturating(signals.changedTypes, 4) * 0.1 +
      saturating(signals.churnCommits, 12) * 0.1 +
      clamp(signals.debt.high / 3) * 0.15 +
      clamp(signals.debt.medium / 5) * 0.08 +
      clamp(signals.debt.low / 8) * 0.03,
    0.01,
    0.95,
  );

  add(
    'structural-prior',
    rounded(structuralPrior),
    structuralPrior,
    'Deterministic prior from dependency, change-shape, churn, and unresolved-debt signals; it is not a historical success rate.',
  );
  add(
    'direct-dependents',
    signals.directDependents,
    saturating(signals.directDependents, 8) * 0.18,
    'More indexed reverse dependents increase the potential blast radius.',
  );
  add(
    'affected-modules',
    signals.affectedModules,
    saturating(signals.affectedModules, 4) * 0.12,
    'Cross-module reach increases the number of boundaries that can regress.',
  );
  add(
    'changed-functions',
    signals.changedFunctions,
    saturating(signals.changedFunctions, 6) * 0.12,
    'Changed function signatures or declarations increase compatibility risk.',
  );
  add(
    'changed-types',
    signals.changedTypes,
    saturating(signals.changedTypes, 4) * 0.1,
    'Changed type declarations can invalidate consumers and generated contracts.',
  );
  add(
    'churn-commits',
    signals.churnCommits,
    saturating(signals.churnCommits, 12) * 0.1,
    'Recent file churn is a weak instability signal, not proof of a defect.',
  );
  add(
    'debt-high',
    signals.debt.high,
    clamp(signals.debt.high / 3) * 0.15,
    'Unresolved high debt increases review risk.',
  );
  add(
    'debt-medium',
    signals.debt.medium,
    clamp(signals.debt.medium / 5) * 0.08,
    'Unresolved medium debt increases review risk with lower weight than high debt.',
  );
  add(
    'debt-low',
    signals.debt.low,
    clamp(signals.debt.low / 8) * 0.03,
    'Low debt is retained as context, not treated as a blocker.',
  );

  const observations = finiteCount(signals.historicalObservations);
  const failures = Math.min(observations, finiteCount(signals.historicalFailures));
  const priorStrength = 8;
  const alpha = structuralPrior * priorStrength + failures;
  const beta = (1 - structuralPrior) * priorStrength + observations - failures;
  const probability = clamp(alpha / (alpha + beta));
  const status =
    observations >= MINIMUM_CALIBRATION_OBSERVATIONS ? 'estimated' : 'insufficient-data';
  const confidence = clamp(observations / (observations + 20));
  const uncertainty: string[] = [...(signals.limitations ?? [])];

  if (!signals.indexed)
    uncertainty.push('The file is not indexed; dependency evidence is unavailable.');
  if (observations < MINIMUM_CALIBRATION_OBSERVATIONS) {
    uncertainty.push(
      `Only ${observations} historical outcome(s) are available; at least ${MINIMUM_CALIBRATION_OBSERVATIONS} are required for a narrower interval.`,
    );
  }
  if (observations === 0)
    uncertainty.push('No historical test-failure outcomes are available for calibration.');
  if (failures < observations) {
    uncertainty.push(`${observations - failures} observed outcome(s) did not record a failure.`);
  }

  // With insufficient outcomes, do not manufacture a narrow confidence range.
  const interval =
    observations < MINIMUM_CALIBRATION_OBSERVATIONS
      ? { lower: 0, upper: 1, level: 0.95 as const }
      : posteriorInterval(alpha, beta);

  return {
    status,
    probability: rounded(probability),
    confidenceInterval: interval,
    confidence: rounded(confidence),
    riskLevel: riskLevelFor(probability),
    calibration: {
      method: 'beta-smoothed-structural-baseline',
      version: CALIBRATION_VERSION,
      observations,
      failures,
      minimumObservations: MINIMUM_CALIBRATION_OBSERVATIONS,
      empiricallyCalibrated: observations >= MINIMUM_CALIBRATION_OBSERVATIONS,
    },
    evidence,
    uncertainty: [...new Set(uncertainty)],
  };
}

function posteriorInterval(
  alpha: number,
  beta: number,
): { lower: number; upper: number; level: 0.95 } {
  const total = alpha + beta;
  const mean = alpha / total;
  const margin = 1.96 * Math.sqrt(Math.max(0, (mean * (1 - mean)) / total));
  return {
    lower: rounded(clamp(mean - margin)),
    upper: rounded(clamp(mean + margin)),
    level: 0.95,
  };
}

function riskLevelFor(probability: number): 'low' | 'medium' | 'high' | 'critical' {
  if (probability >= 0.75) return 'critical';
  if (probability >= 0.5) return 'high';
  if (probability >= 0.25) return 'medium';
  return 'low';
}

/** Collect graph, debt, churn, and recorded outcome signals for one file. */
export function collectRiskSignals(input: RiskSignalCollectionInput): RiskSignals {
  const file = input.graph.getFileByPath(input.filePath);
  const dependents = file ? input.graph.getDependents(file.id) : [];
  const moduleNames = new Set(
    dependents.map((dependent) => dependent.relativePath.split(/[\\/]/)[0]).filter(Boolean),
  );
  if (file) moduleNames.add(file.relativePath.split(/[\\/]/)[0] || '.');

  const debt = { high: 0, medium: 0, low: 0 };
  try {
    const rows = input.db
      .prepare(
        `SELECT severity, COUNT(*) AS count
         FROM debt_items
         WHERE project_id = ? AND file_id = ? AND resolved = 0
         GROUP BY severity`,
      )
      .all(input.projectId, file?.id ?? -1) as Array<{ severity: string; count: number }>;
    for (const row of rows) {
      if (row.severity === 'high' || row.severity === 'medium' || row.severity === 'low') {
        debt[row.severity] = finiteCount(row.count);
      }
    }
  } catch (error) {
    // Older databases without debt tables expose the missing signal through
    // the limitation instead of turning a risk query into a hard failure.
    reportSuppressedError(error, 'Risk debt signal unavailable on this database');
  }

  let historicalFailures = 0;
  let historicalObservations = 0;
  try {
    const paths = [input.filePath, file?.path, file?.relativePath].filter((path): path is string =>
      Boolean(path),
    );
    const placeholders = paths.map(() => '?').join(', ');
    const rows = input.db
      .prepare(
        `SELECT failure_occurred
         FROM test_failure_log
         WHERE file_path IN (${placeholders})`,
      )
      .all(...paths) as Array<{ failure_occurred: number }>;
    historicalObservations = rows.length;
    historicalFailures = rows.filter((row) => Boolean(row.failure_occurred)).length;
  } catch (error) {
    // The predictor's outcome table is optional on old/partial databases.
    reportSuppressedError(error, 'Risk history signal unavailable on this database');
  }

  const limitations: string[] = [];
  if (!file) limitations.push('The requested file was not found in the current project index.');
  if (input.churnCommits === undefined) {
    limitations.push(
      'Recent churn was not supplied; this assessment does not infer git history implicitly.',
    );
  }

  return {
    filePath: input.filePath,
    indexed: Boolean(file),
    directDependents: dependents.length,
    affectedModules: moduleNames.size,
    changedFunctions: finiteCount(input.changedFunctions),
    changedTypes: finiteCount(input.changedTypes),
    churnCommits: finiteCount(input.churnCommits),
    debt,
    historicalFailures,
    historicalObservations,
    limitations,
  };
}
