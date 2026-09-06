import { Command } from 'commander';
import { withService, asyncHandler, output, logger } from '@/cli/utils/shared.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ScaleManager } from '../../core/scale/manager.js';
import { getDatabase } from '../../storage/database.js';

interface PrImpact {
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  affectedModules: { path: string; files: string[]; risk: 'high' | 'medium' | 'low' }[];
  coherenceRisk: 'low' | 'medium' | 'high';
  testSelection: string[];
  estimatedReviewTime: number; // minutes
  breakingChanges: string[];
  coherenceIssues: { file: string; verdict: string; issues: string[] }[];
  findings: ReviewFinding[];
  reviewerConsensus: {
    reviewers: Array<{ name: string; findingCount: number }>;
    consolidatedFindingCount: number;
  };
}

interface ReviewFinding {
  fingerprint: string;
  rule: string;
  severity: 'high' | 'medium' | 'low';
  file: string;
  line: number;
  message: string;
}

export function createPrPreviewCommand(): Command {
  const prCmd = new Command('pr-preview')
    .alias('review')
    .description(
      'Preview PR impact: changed files, affected modules, test selection, coherence risk',
    )
    .option('-b, --base <ref>', 'Base branch/ref', 'main')
    .option('-h, --head <ref>', 'Head branch/ref', 'HEAD')
    .option('--format <fmt>', 'Output: text|json|markdown|github', 'text')
    .option('-o, --output <file>', 'Write to file')
    .option('--no-tests', 'Skip test selection')
    .option('--no-coherence', 'Skip coherence check')
    .option('--history', 'Persist findings and reconcile resolved findings')
    .action(
      asyncHandler(
        async (opts: {
          base: string;
          head: string;
          format: string;
          output: string;
          tests: boolean;
          coherence: boolean;
          history?: boolean;
        }) => {
          await withService(['scale', 'coherence'], async (_ctx, services) => {
            const scale = services.scale!;
            const coherence = services.coherence!;
            const { loadConfig } = await import('../../utils/config.js');
            const config = loadConfig();

            output.section('PR Impact Preview');
            output.kv('Base', opts.base);
            output.kv('Head', opts.head);

            // Changed files via real three-dot/two-dot/uncommitted git diff.
            const changedFiles = await getChangedFiles(opts.base, opts.head, config.projectRoot);

            if (changedFiles.length === 0) {
              if (opts.history) {
                const history = persistReviewHistory(
                  _ctx.kg.getCurrentProjectId(),
                  opts.base,
                  opts.head,
                  changedFiles,
                  [],
                );
                output.kv('Review history', `${history.open} open, ${history.resolved} resolved`);
              }
              output.success('No changes detected.');
              return;
            }

            output.kv('Changed files', changedFiles.length);

            // Analyze affected modules
            const affectedModules = analyzeAffectedModules(changedFiles, scale);

            // Coherence risk assessment
            let coherenceRisk: 'low' | 'medium' | 'high' = 'low';
            const coherenceIssues: PrImpact['coherenceIssues'] = [];

            if (opts.coherence) {
              output.info('Running coherence checks on changed files...');
              for (const file of changedFiles.slice(0, 20)) {
                try {
                  const { readFileSync } = await import('node:fs');
                  const { join } = await import('node:path');
                  const content = readFileSync(join(config.projectRoot, file), 'utf-8');
                  const result = await coherence.checkCoherence({
                    code: content,
                    filePath: file,
                    fastOnly: true,
                  });

                  if (result.verdict !== 'pass') {
                    coherenceIssues.push({
                      file,
                      verdict: result.verdict,
                      issues: result.suggestions,
                    });
                  }
                } catch (e) {
                  logger.warn(
                    `Skipping unreadable file in PR preview: ${file} - ${e instanceof Error ? e.message : String(e)}`,
                  );
                }
              }

              const failCount = coherenceIssues.filter((i) => i.verdict === 'fail').length;
              const warnCount = coherenceIssues.filter((i) => i.verdict === 'warn').length;

              if (failCount > 0) coherenceRisk = 'high';
              else if (warnCount > 2) coherenceRisk = 'medium';
              else if (warnCount > 0) coherenceRisk = 'low';
            }

            // Deterministic heuristic selection: src->tests path mapping + module tests.
            let testSelection: string[] = [];
            if (opts.tests) {
              testSelection = selectTests(changedFiles, scale);
            }

            // Breaking changes detection
            const breakingChanges = detectBreakingChanges(changedFiles, scale);

            // Fast deterministic review baseline. These findings are line-level
            // and require no LLM, so they remain reproducible in CI.
            const findings = collectReviewFindings(changedFiles, config.projectRoot);
            const reviewerConsensus = buildReviewerConsensus(
              findings,
              coherenceIssues,
              breakingChanges,
            );

            // Estimated review time
            const estimatedReviewTime = estimateReviewTime(
              changedFiles.length,
              coherenceRisk,
              testSelection.length,
            );

            const impact: PrImpact = {
              baseRef: opts.base,
              headRef: opts.head,
              changedFiles,
              affectedModules,
              coherenceRisk,
              testSelection,
              estimatedReviewTime,
              breakingChanges,
              coherenceIssues,
              findings,
              reviewerConsensus,
            };

            if (opts.history) {
              const history = persistReviewHistory(
                _ctx.kg.getCurrentProjectId(),
                opts.base,
                opts.head,
                changedFiles,
                findings,
                changedFiles,
              );
              output.kv('Review history', `${history.open} open, ${history.resolved} resolved`);
            }

            if (opts.format === 'json') {
              const content = JSON.stringify(impact, null, 2);
              if (opts.output) {
                writeFileSync(opts.output, content);
                output.success(`Written to ${opts.output}`);
              } else {
                process.stdout.write(`${content}\n`);
              }
              return;
            }

            if (opts.format === 'markdown') {
              const content = generateMarkdownPrPreview(impact);
              if (opts.output) {
                writeFileSync(opts.output, content);
                output.success(`Written to ${opts.output}`);
              } else {
                process.stdout.write(`${content}\n`);
              }
              return;
            }

            if (opts.format === 'github') {
              // GitHub-flavored markdown suitable for `gh pr comment --body-file`.
              const md = generateMarkdownPrPreview(impact);
              const summary = [
                '## 🧠 ProjectMind PR Analysis',
                '',
                `<details><summary>Changed files: ${impact.changedFiles.length} — full report</summary>`,
                '',
                md,
                '',
                '</details>',
                '',
                `_Generated by ProjectMind · post with: gh pr comment <n> --body-file report.md_`,
                '',
              ].join('\n');
              if (opts.output) {
                writeFileSync(opts.output, summary);
                output.success(`GitHub comment markdown written to ${opts.output}`);
              } else {
                process.stdout.write(`${summary}\n`);
              }
              return;
            }

            // Text format
            output.section(`Changed Files (${changedFiles.length})`);
            for (const file of changedFiles.slice(0, 30)) {
              output.kv(`  ${file}`, '');
            }
            if (changedFiles.length > 30) {
              output.kv(`  ... and ${changedFiles.length - 30} more`, '');
            }

            output.section(`Affected Modules (${affectedModules.length})`);
            for (const mod of affectedModules) {
              output.kv(`  ${mod.path}`, `${mod.files.length} files | Risk: ${mod.risk}`);
            }

            output.section('Coherence Risk Assessment');
            const riskIcon =
              coherenceRisk === 'high' ? '🔴' : coherenceRisk === 'medium' ? '🟡' : '🟢';
            output.kv(`${riskIcon} Overall Risk`, coherenceRisk.toUpperCase());
            output.kv('Files with issues', coherenceIssues.length);
            output.kv('Deterministic findings', findings.length);
            output.kv(
              'Reviewer consensus',
              `${reviewerConsensus.consolidatedFindingCount} consolidated finding(s)`,
            );

            if (findings.length > 0) {
              output.section('Deterministic Review Findings');
              for (const finding of findings.slice(0, 30)) {
                output.kv(
                  `  [${finding.severity.toUpperCase()}] ${finding.file}:${finding.line}`,
                  `${finding.rule}: ${finding.message}`,
                );
              }
            }

            if (coherenceIssues.length > 0) {
              for (const issue of coherenceIssues.slice(0, 10)) {
                output.kv(
                  `  ${issue.verdict === 'fail' ? '🔴' : '🟡'} ${issue.file}`,
                  issue.issues.join('; '),
                );
              }
            }

            if (opts.tests) {
              output.section(`Suggested Tests (${testSelection.length})`);
              for (const test of testSelection.slice(0, 15)) {
                output.kv(`  🧪 ${test}`, '');
              }
            }

            if (breakingChanges.length > 0) {
              output.section(`⚠️ Potential Breaking Changes (${breakingChanges.length})`);
              for (const change of breakingChanges) {
                output.kv(`  ${change}`, '');
              }
            }

            output.section('Estimated Review Time');
            output.kv('Time', `${estimatedReviewTime} minutes`);
            output.kv(
              'Basis',
              `${changedFiles.length} files, ${coherenceRisk} coherence risk, ${testSelection.length} tests`,
            );

            if (opts.output) {
              writeFileSync(opts.output, JSON.stringify(impact, null, 2));
              output.success(`Written to ${opts.output}`);
            }
          });
        },
      ),
    );

  return prCmd;
}

async function getChangedFiles(base: string, head: string, projectRoot: string): Promise<string[]> {
  const { spawnSync } = await import('node:child_process');
  const codeExts = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

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

function analyzeAffectedModules(
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

function selectTests(changedFiles: string[], scale: ScaleManager): string[] {
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

function detectBreakingChanges(changedFiles: string[], scale: ScaleManager): string[] {
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

function collectReviewFindings(changedFiles: string[], projectRoot: string): ReviewFinding[] {
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
      lines = readFileSync(join(projectRoot, file), 'utf-8').split(/\r?\n/);
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

function persistReviewHistory(
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

/**
 * Coordinates the independent deterministic, coherence, and impact reviewers.
 * Findings remain keyed by fingerprint, so consensus never creates duplicates.
 */
function buildReviewerConsensus(
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

function estimateReviewTime(fileCount: number, coherenceRisk: string, testCount: number): number {
  let time = fileCount * 3; // 3 minutes per file base

  if (coherenceRisk === 'high') time += 30;
  else if (coherenceRisk === 'medium') time += 15;

  time += testCount * 2; // 2 minutes per test

  return Math.max(time, 10);
}

function generateMarkdownPrPreview(impact: PrImpact): string {
  const lines = [
    `# PR Impact Preview`,
    '',
    `**Base:** ${impact.baseRef} | **Head:** ${impact.headRef}`,
    `**Generated:** ${new Date().toISOString().split('T')[0]}`,
    '',
    `## Summary`,
    `- **Changed Files:** ${impact.changedFiles.length}`,
    `- **Affected Modules:** ${impact.affectedModules.length}`,
    `- **Coherence Risk:** ${impact.coherenceRisk.toUpperCase()}`,
    `- **Suggested Tests:** ${impact.testSelection.length}`,
    `- **Breaking Changes:** ${impact.breakingChanges.length}`,
    `- **Deterministic Findings:** ${impact.findings.length}`,
    `- **Estimated Review Time:** ${impact.estimatedReviewTime} minutes`,
    '',
    `## Changed Files`,
    '',
    ...impact.changedFiles.map((f) => `- \`${f}\``),
    '',
    `## Affected Modules`,
    '',
    ...impact.affectedModules.map((m) => `- **${m.path}** (${m.risk}): ${m.files.join(', ')}`),
    '',
    `## Coherence Issues`,
    '',
    ...impact.coherenceIssues.map(
      (i) => `- **${i.verdict.toUpperCase()}** \`${i.file}\`: ${i.issues.join('; ')}`,
    ),
    '',
    `## Breaking Changes`,
    '',
    ...impact.breakingChanges.map((b) => `- ⚠️ ${b}`),
    '',
    `## Deterministic Review Findings`,
    '',
    ...impact.findings.map(
      (f) => `- **${f.severity.toUpperCase()}** [${f.rule}] \`${f.file}:${f.line}\`: ${f.message}`,
    ),
    '',
    `## Suggested Tests`,
    '',
    ...impact.testSelection.map((t) => `- \`${t}\``),
    '',
    `## Estimated Review Time: ${impact.estimatedReviewTime} minutes`,
    '',
  ];

  return lines.join('\n');
}
