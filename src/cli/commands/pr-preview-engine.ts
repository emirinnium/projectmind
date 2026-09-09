import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ScaleManager } from '../../core/scale/manager.js';
import { getDatabase } from '../../storage/database.js';
import { confineToProject } from '../../mcp/tools/_shared.js';
import { logger } from '@/utils/logger.js';

export interface ReviewFinding {
  fingerprint: string;
  rule: string;
  severity: 'high' | 'medium' | 'low';
  file: string;
  line: number;
  message: string;
}

export interface PrImpact {
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  affectedModules: { path: string; files: string[]; risk: 'high' | 'medium' | 'low' }[];
  coherenceRisk: 'low' | 'medium' | 'high';
  testSelection: string[];
  estimatedReviewTime: number;
  breakingChanges: string[];
  coherenceIssues: { file: string; verdict: string; issues: string[] }[];
  findings: ReviewFinding[];
  reviewerConsensus: {
    reviewers: Array<{ name: string; findingCount: number }>;
    consolidatedFindingCount: number;
  };
}

export async function getChangedFiles(
  base: string,
  head: string,
  projectRoot: string,
): Promise<string[]> {
  const { spawnSync } = await import('node:child_process');
  const codeExts = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
  validateGitRevision(base, 'base');
  validateGitRevision(head, 'head');

  // Prefer three-dot (merge-base) diff — this is exactly what a PR shows.
  for (const range of [`${base}...${head}`, `${base}..${head}`] as const) {
    const result = spawnSync('git', ['diff', '--name-only', range], {
      cwd: projectRoot,
      encoding: 'utf-8',
    });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout
        .trim()
        .split(/\r?\n/)
        .filter((f) => codeExts.test(f));
    }
  }

  // Final fallback: uncommitted working-tree changes against head, so
  // pre-commit previews still reflect reality.
  const uncommitted = spawnSync('git', ['diff', '--name-only', head], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });
  if (uncommitted.status === 0 && uncommitted.stdout.trim()) {
    return uncommitted.stdout
      .trim()
      .split(/\r?\n/)
      .filter((f) => codeExts.test(f));
  }

  // NEVER fabricate file lists: report nothing and say why.
  logger.warn('git diff unavailable for this repository/ref pair; reporting zero changed files.');
  return [];
}

/**
 * Validate revision selectors before composing a git range. The command is
 * still executed through an argv API, but rejecting option-looking/control
 * input prevents a caller from changing Git's option parsing or injecting
 * ambiguous range syntax. Common selectors such as HEAD~1 and refs/pull/*
 * remain valid.
 */
export function validateGitRevision(value: string, label: 'base' | 'head'): string {
  if (
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    value.startsWith('-') ||
    /[\0\r\n\t\s]/.test(value)
  ) {
    throw new Error(
      `Invalid ${label} Git revision. Use a branch, tag, commit, or selector such as HEAD~1 without whitespace or leading '-'.`,
    );
  }
  return value;
}

export function analyzeAffectedModules(
  changedFiles: string[],
  scale: ScaleManager,
): { path: string; files: string[]; risk: 'high' | 'medium' | 'low' }[] {
  const report = scale.getScaleReport();
  const moduleMap = new Map<string, { files: string[]; risk: 'high' | 'medium' | 'low' }>();

  for (const file of changedFiles) {
    for (const module of report.modules) {
      const moduleFile = module.files?.find(
        (f) => f.relativePath === file || f.path.endsWith(file),
      );
      if (moduleFile) {
        const existing = moduleMap.get(module.path) || { files: [], risk: 'low' };
        existing.files.push(file);

        // Assess risk based on file properties
        const fileCognitiveLoad = moduleFile.cognitiveLoad || 0;
        if (fileCognitiveLoad > 0.5) existing.risk = 'high';
        else if (fileCognitiveLoad > 0.2) existing.risk = 'medium';

        moduleMap.set(module.path, existing);
        break;
      }
    }
  }

  return Array.from(moduleMap.entries()).map(([path, data]) => ({
    path,
    files: data.files,
    risk: data.risk,
  }));
}

export function selectTests(changedFiles: string[], scale: ScaleManager): string[] {
  const report = scale.getScaleReport();
  const tests: string[] = [];

  for (const file of changedFiles) {
    const testFile = file
      .replace('src/', 'tests/')
      .replace(/\.ts$/, '.test.ts')
      .replace(/\.js$/, '.test.js');
    tests.push(testFile);

    // Also find tests in same module
    for (const module of report.modules) {
      if (module.files?.some((f) => f.relativePath === file)) {
        // Add module-level tests
        for (const f of module.files || []) {
          if (f.relativePath.includes('.test.') || f.relativePath.includes('.spec.')) {
            tests.push(f.relativePath);
          }
        }
      }
    }
  }

  return [...new Set(tests)];
}

export function detectBreakingChanges(changedFiles: string[], scale: ScaleManager): string[] {
  const breaking: string[] = [];
  const report = scale.getScaleReport();

  for (const file of changedFiles) {
    // Check if file exports public API
    for (const module of report.modules) {
      const moduleFile = module.files?.find((f) => f.relativePath === file);
      if (moduleFile && moduleFile.agentTouched) {
        breaking.push(`Public API change in ${file} (touched by agents)`);
      }
    }

    // Check for common breaking patterns
    if (file.includes('index.ts') || file.includes('types.ts') || file.includes('contracts')) {
      breaking.push(`Core types/exports changed: ${file}`);
    }
  }

  return [...new Set(breaking)];
}

export function collectReviewFindings(
  changedFiles: string[],
  projectRoot: string,
): ReviewFinding[] {
  const rules: Array<{
    rule: string;
    severity: ReviewFinding['severity'];
    pattern: RegExp;
    message: string;
  }> = [
    {
      rule: 'dangerous-eval',
      severity: 'high',
      pattern: /\b(?:eval|new\s+Function)\s*\(/,
      message: 'Dynamic code execution requires explicit security review.',
    },
    {
      rule: 'possible-secret',
      severity: 'high',
      pattern: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}/i,
      message: 'Possible hard-coded credential or secret.',
    },
    {
      rule: 'todo-marker',
      severity: 'low',
      pattern: /\b(?:TODO|FIXME|HACK)\b/i,
      message: 'Unresolved work marker in changed code.',
    },
    {
      rule: 'explicit-any',
      severity: 'medium',
      pattern: /\bany\b/,
      message: 'Explicit any weakens the static contract at a changed line.',
    },
    {
      rule: 'console-output',
      severity: 'low',
      pattern: /\bconsole\.(?:log|error|warn|debug)\s*\(/,
      message: 'Ad-hoc console output should be reviewed for production behavior.',
    },
  ];
  const findings: ReviewFinding[] = [];
  for (const file of changedFiles) {
    let lines: string[];
    try {
      lines = readFileSync(confineToProject(file, projectRoot), 'utf-8').split(/\r?\n/);
    } catch {
      continue;
    }
    lines.forEach((line, index) => {
      for (const rule of rules) {
        if (rule.pattern.test(line)) {
          findings.push({
            fingerprint: `${rule.rule}:${file}:${stableFindingIdentity(lines, index)}`,
            rule: rule.rule,
            severity: rule.severity,
            file,
            line: index + 1,
            message: rule.message,
          });
        }
        rule.pattern.lastIndex = 0;
      }
    });
  }
  return findings;
}

function stableFindingIdentity(lines: string[], index: number): string {
  const context = lines
    .slice(Math.max(0, index - 1), Math.min(lines.length, index + 2))
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n');
  return createHash('sha256').update(context).digest('hex').slice(0, 16);
}

export function persistReviewHistory(
  projectId: number,
  baseRef: string,
  headRef: string,
  changedFiles: string[],
  findings: ReviewFinding[],
  reconciliationFiles: string[] = changedFiles,
): { open: number; resolved: number } {
  const db = getDatabase();
  const run = db
    .prepare(
      'INSERT INTO review_runs (project_id, base_ref, head_ref, changed_files) VALUES (?, ?, ?, ?)',
    )
    .run(projectId, baseRef, headRef, changedFiles.length);
  const runId = Number(run.lastInsertRowid);
  const upsert = db.prepare(`
    INSERT INTO review_findings
      (run_id, project_id, fingerprint, rule, severity, file, line, message, status, last_seen_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', CURRENT_TIMESTAMP, NULL)
    ON CONFLICT(project_id, fingerprint) DO UPDATE SET
      run_id=excluded.run_id, severity=excluded.severity, file=excluded.file,
      line=excluded.line, message=excluded.message, status='open',
      last_seen_at=CURRENT_TIMESTAMP, resolved_at=NULL
  `);
  for (const finding of findings) {
    upsert.run(
      runId,
      projectId,
      finding.fingerprint,
      finding.rule,
      finding.severity,
      finding.file,
      finding.line,
      finding.message,
    );
  }
  if (reconciliationFiles.length > 0) {
    const filePlaceholders = reconciliationFiles.map(() => '?').join(', ');
    const findingPlaceholders = findings.length > 0 ? findings.map(() => '?').join(', ') : "''";
    const findingParams = findings.map((finding) => finding.fingerprint);
    db.prepare(
      `UPDATE review_findings SET status='resolved', resolved_at=CURRENT_TIMESTAMP
       WHERE project_id = ? AND status='open'
         AND file IN (${filePlaceholders})
         AND fingerprint NOT IN (${findingPlaceholders})`,
    ).run(projectId, ...reconciliationFiles, ...findingParams);
  }
  const counts = db
    .prepare(
      'SELECT status, COUNT(*) AS count FROM review_findings WHERE project_id = ? GROUP BY status',
    )
    .all(projectId) as Array<{ status: string; count: number }>;
  return {
    open: counts.find((row) => row.status === 'open')?.count ?? 0,
    resolved: counts.find((row) => row.status === 'resolved')?.count ?? 0,
  };
}

export function buildReviewerConsensus(
  findings: ReviewFinding[],
  coherenceIssues: PrImpact['coherenceIssues'],
  breakingChanges: string[],
): PrImpact['reviewerConsensus'] {
  const reviewers = [
    { name: 'deterministic-rules', findingCount: findings.length },
    { name: 'coherence-engine', findingCount: coherenceIssues.length },
    { name: 'impact-engine', findingCount: breakingChanges.length },
  ];
  return {
    reviewers,
    consolidatedFindingCount: new Set([
      ...findings.map((finding) => finding.fingerprint),
      ...coherenceIssues.map((issue) => `coherence:${issue.file}`),
      ...breakingChanges.map((change) => `impact:${change}`),
    ]).size,
  };
}

export function estimateReviewTime(
  fileCount: number,
  coherenceRisk: string,
  testCount: number,
): number {
  let time = fileCount * 3; // 3 minutes per file base

  if (coherenceRisk === 'high') time += 30;
  else if (coherenceRisk === 'medium') time += 15;

  time += testCount * 2; // 2 minutes per test

  return Math.max(time, 10);
}
