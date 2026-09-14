import type { DatabaseSync } from 'node:sqlite';
import type { FileInfo } from '../../storage/kg/types.js';
import type { KnowledgeGraph } from '../../storage/knowledge-graph.js';
import { collectGitChurn, type GitChurnEntry } from '../debt/git-churn.js';

export interface BugSurfaceSignals {
  path: string;
  churnCommits: number;
  authors: number;
  directDependents: number;
  maxComplexity: number;
  historicalFailures: number;
  historicalObservations: number;
  debt: { high: number; medium: number; low: number };
  coherenceWarnings: number;
  coherenceFailures: number;
  testPath: boolean;
}

export interface BugSurfaceItem {
  path: string;
  score: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  signals: BugSurfaceSignals;
  evidence: string[];
  suggestions: string[];
  confidence: number;
}

export interface BugSurfaceReport {
  mode: 'predictive';
  sinceDays: number;
  filesConsidered: number;
  filesReported: number;
  items: BugSurfaceItem[];
  summary: {
    riskLevel: BugSurfaceItem['riskLevel'];
    highOrCritical: number;
    averageScore: number;
  };
  limitations: string[];
}

export interface BugSurfaceOptions {
  sinceDays?: number;
  limit?: number;
  minimumScore?: number;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function count(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0;
}

function level(score: number): BugSurfaceItem['riskLevel'] {
  if (score >= 0.78) return 'critical';
  if (score >= 0.56) return 'high';
  if (score >= 0.3) return 'medium';
  return 'low';
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function riskItem(signals: BugSurfaceSignals): BugSurfaceItem {
  const failureRate =
    signals.historicalObservations > 0
      ? signals.historicalFailures / signals.historicalObservations
      : 0;
  const churn = clamp(signals.churnCommits / 12);
  const ownership = clamp(Math.max(0, signals.authors - 1) / 4);
  const complexity = clamp(signals.maxComplexity / 15);
  const dependency = clamp(signals.directDependents / 10);
  const debt = clamp(
    signals.debt.high * 0.35 + signals.debt.medium * 0.16 + signals.debt.low * 0.03,
  );
  const coherence = clamp(signals.coherenceFailures * 0.3 + signals.coherenceWarnings * 0.08);
  const score =
    Math.round(
      clamp(
        failureRate * 0.28 +
          churn * 0.18 +
          ownership * 0.1 +
          complexity * 0.15 +
          dependency * 0.1 +
          debt * 0.13 +
          coherence * 0.06,
      ) * 10_000,
    ) / 10_000;
  const evidence: string[] = [];
  const suggestions: string[] = [];
  if (signals.historicalObservations > 0) {
    evidence.push(
      `${signals.historicalFailures}/${signals.historicalObservations} recorded historical outcome(s) failed`,
    );
    if (failureRate >= 0.3)
      suggestions.push('Add or strengthen regression coverage around this file.');
  }
  if (signals.churnCommits > 0)
    evidence.push(`${signals.churnCommits} change(s) in the selected Git window`);
  if (signals.authors > 1)
    evidence.push(`${signals.authors} distinct author(s) in the selected Git window`);
  if (signals.directDependents > 0)
    evidence.push(`${signals.directDependents} direct dependent(s) in the graph`);
  if (signals.maxComplexity > 0)
    evidence.push(`maximum indexed function complexity ${signals.maxComplexity}`);
  if (signals.debt.high + signals.debt.medium + signals.debt.low > 0) {
    evidence.push(
      `unresolved debt: ${signals.debt.high} high, ${signals.debt.medium} medium, ${signals.debt.low} low`,
    );
    suggestions.push('Resolve the highest-severity debt before changing this file.');
  }
  if (signals.coherenceFailures > 0 || signals.coherenceWarnings > 0) {
    evidence.push(
      `coherence history: ${signals.coherenceFailures} fail, ${signals.coherenceWarnings} warn`,
    );
    suggestions.push('Run check_coherence and inspect the recorded reasoning trace.');
  }
  if (signals.testPath)
    suggestions.push(
      'This is a test file; correlate risk with its production dependents before prioritizing it.',
    );
  if (evidence.length === 0)
    evidence.push('No measured risk signal crossed the evidence collection boundary.');
  const measuredSignals = [
    signals.churnCommits > 0,
    signals.authors > 0,
    signals.directDependents > 0,
    signals.maxComplexity > 0,
    signals.historicalObservations > 0,
    signals.debt.high + signals.debt.medium + signals.debt.low > 0,
    signals.coherenceFailures + signals.coherenceWarnings > 0,
  ].filter(Boolean).length;
  return {
    path: signals.path,
    score,
    riskLevel: level(score),
    signals,
    evidence,
    suggestions: [...new Set(suggestions)],
    confidence: Math.round((measuredSignals / 7) * 10_000) / 10_000,
  };
}

/**
 * Build a transparent predictive bug-surface report from existing local
 * evidence. It intentionally reports a risk ranking, not a calibrated
 * probability; independent labeled outcomes are required for calibration.
 */
export function buildBugSurfaceReport(
  db: DatabaseSync,
  kg: Pick<
    KnowledgeGraph,
    'getAllFiles' | 'getDependents' | 'getFunctions' | 'getCurrentProjectId'
  >,
  projectRoot: string,
  options: BugSurfaceOptions = {},
): BugSurfaceReport {
  const sinceDays = options.sinceDays ?? 90;
  if (!Number.isSafeInteger(sinceDays) || sinceDays < 1 || sinceDays > 3650) {
    throw new Error('Bug-surface sinceDays must be an integer between 1 and 3650.');
  }
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('Bug-surface limit must be an integer between 1 and 500.');
  }
  const minimumScore = options.minimumScore ?? 0;
  if (!Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 1) {
    throw new Error('Bug-surface minimumScore must be between 0 and 1.');
  }
  const projectId = kg.getCurrentProjectId();
  const files = kg.getAllFiles();
  const churn = collectGitChurn(projectRoot, sinceDays);
  const items = files
    .map((file) => buildItem(db, kg, projectId, file, churn))
    .filter((item) => item.score >= minimumScore)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit);
  const averageScore =
    items.length === 0
      ? 0
      : Math.round((items.reduce((sum, item) => sum + item.score, 0) / items.length) * 10_000) /
        10_000;
  const highOrCritical = items.filter(
    (item) => item.riskLevel === 'high' || item.riskLevel === 'critical',
  ).length;
  const overall = items.reduce<BugSurfaceItem['riskLevel']>(
    (current, item) =>
      ['low', 'medium', 'high', 'critical'].indexOf(item.riskLevel) >
      ['low', 'medium', 'high', 'critical'].indexOf(current)
        ? item.riskLevel
        : current,
    'low',
  );
  return {
    mode: 'predictive',
    sinceDays,
    filesConsidered: files.length,
    filesReported: items.length,
    items,
    summary: { riskLevel: overall, highOrCritical, averageScore },
    limitations: [
      'This is a deterministic risk ranking, not a calibrated probability or proof of a future bug.',
      'Historical failure observations are used only when explicitly recorded in test_failure_log.',
      'Dependency freshness and runtime/framework dispatch are not inferred by this report; use deps-fresh and impact tools separately.',
      ...(churn.size === 0
        ? ['Git churn was unavailable or the selected window had no parseable history.']
        : []),
    ],
  };
}

function buildItem(
  db: DatabaseSync,
  kg: Pick<KnowledgeGraph, 'getDependents' | 'getFunctions'>,
  projectId: number,
  file: FileInfo,
  churn: ReadonlyMap<string, GitChurnEntry>,
): BugSurfaceItem {
  const path = normalizePath(file.relativePath || file.path);
  const churnEntry = churn.get(path);
  const debt = { high: 0, medium: 0, low: 0 };
  try {
    const rows = db
      .prepare(
        `SELECT severity, COUNT(*) AS count FROM debt_items
         WHERE project_id = ? AND file_id = ? AND resolved = 0 GROUP BY severity`,
      )
      .all(projectId, file.id) as Array<{ severity: string; count: number }>;
    for (const row of rows) {
      if (row.severity === 'high' || row.severity === 'medium' || row.severity === 'low') {
        debt[row.severity] = count(row.count);
      }
    }
  } catch {
    // Partial legacy databases simply contribute a zero debt signal.
  }
  let historicalFailures = 0;
  let historicalObservations = 0;
  try {
    const paths = [...new Set([file.path, file.relativePath])];
    const rows = db
      .prepare(
        `SELECT failure_occurred FROM test_failure_log
         WHERE file_path IN (${paths.map(() => '?').join(',')})`,
      )
      .all(...paths) as Array<{ failure_occurred: number }>;
    historicalObservations = rows.length;
    historicalFailures = rows.filter((row) => row.failure_occurred === 1).length;
  } catch {
    // Optional historical table/signal; the limitation is represented by 0 observations.
  }
  let coherenceWarnings = 0;
  let coherenceFailures = 0;
  try {
    const rows = db
      .prepare(
        `SELECT verdict, COUNT(*) AS count FROM coherence_decisions
         WHERE file_id = ? GROUP BY verdict`,
      )
      .all(file.id) as Array<{ verdict: string; count: number }>;
    for (const row of rows) {
      if (row.verdict === 'warn') coherenceWarnings = count(row.count);
      if (row.verdict === 'fail') coherenceFailures = count(row.count);
    }
  } catch {
    // Optional historical coherence signal.
  }
  const functions = kg.getFunctions(file.id);
  const maxComplexity = functions.reduce(
    (maximum, fn) => Math.max(maximum, count(fn.complexity)),
    0,
  );
  return riskItem({
    path,
    churnCommits: churnEntry?.count ?? 0,
    authors: churnEntry?.authors.size ?? 0,
    directDependents: kg.getDependents(file.id).length,
    maxComplexity,
    historicalFailures,
    historicalObservations,
    debt,
    coherenceWarnings,
    coherenceFailures,
    testPath: /(^|\/)(tests?|__tests__)\//i.test(path) || /\.(test|spec)\.[^.]+$/i.test(path),
  });
}
