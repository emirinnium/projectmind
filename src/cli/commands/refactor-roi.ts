import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { writeFileSync } from 'node:fs';
import { collectGitChurn } from '@/cli/utils/git-churn.js';
import { loadConfig } from '@/cli/utils/shared.js';

interface RefactorCandidate {
  file: string;
  module: string;
  type: 'extract-function' | 'extract-class' | 'inline' | 'rename' | 'move' | 'simplify';
  description: string;
  cognitiveLoad: number;
  churn: number;
  debtCount: number;
  coupling: number;
  estimatedEffortHours: number;
  riskReduction: number;
  frequency: number;
  roi: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
  suggestion: string;
}

interface FileInfoForRefactor {
  relativePath: string;
  path: string;
  cognitiveLoad: number;
  lines: number;
  agentTouched: boolean;
  imports?: Array<{ source: string }>;
  churn?: number;
}

interface DebtReportForRefactor {
  items: Array<{
    filePath: string | null;
    type: string;
    severity: string;
    description: string;
    suggestion: string;
  }>;
}

export function createRefactorRoiCommand(): Command {
  const roiCmd = new Command('refactor-roi')
    .description('Calculate refactoring ROI: (risk reduction × frequency) / effort')
    .option('--target <path>', 'Target file or directory')
    .option('--min-roi <n>', 'Minimum ROI threshold', '1.0')
    .option('--max-effort <n>', 'Maximum effort in hours', '40')
    .option(
      '--type <type>',
      'Refactor type filter: all|extract-function|extract-class|inline|rename|move|simplify',
      'all',
    )
    .option('--format <fmt>', 'Output: text|json|csv', 'text')
    .option('-o, --output <file>', 'Write to file')
    .action(
      asyncHandler(
        async (opts: {
          target: string;
          minRoi: string;
          maxEffort: string;
          type: string;
          format: string;
          output: string;
        }) => {
          await withService(['scale', 'debt'], async (_ctx, services) => {
            const scale = services.scale!;
            const debt = services.debt!;

            output.section('Refactoring ROI Calculator');
            output.kv('Min ROI', opts.minRoi);
            output.kv('Max effort', `${opts.maxEffort}h`);
            output.kv('Type filter', opts.type);

            const report = scale.getScaleReport();
            const allFiles: FileInfoForRefactor[] = report.modules.flatMap((m) =>
              (m.files || []).map((f) => ({
                relativePath: f.relativePath,
                path: f.path,
                cognitiveLoad: f.cognitiveLoad,
                lines: f.sizeBytes ? Math.ceil(f.sizeBytes / 50) : 0,
                agentTouched: f.agentTouched,
                imports: [],
              })),
            );

            let filesToAnalyze = allFiles;
            if (opts.target) {
              filesToAnalyze = allFiles.filter(
                (f) => f.relativePath.includes(opts.target) || f.path.includes(opts.target),
              );
            }

            if (filesToAnalyze.length === 0) {
              output.warn('No files found matching target');
              return;
            }

            output.kv('Files to analyze', filesToAnalyze.length);

            // Generate refactor candidates
            const candidates = generateRefactorCandidates(filesToAnalyze, debt.getReport());

            // Filter by type
            let filtered = candidates;
            if (opts.type !== 'all') {
              filtered = candidates.filter((c) => c.type === opts.type);
            }

            // Filter by ROI and effort
            const minRoi = parseFloat(opts.minRoi);
            const maxEffort = parseInt(opts.maxEffort, 10);
            filtered = filtered.filter(
              (c) => c.roi >= minRoi && c.estimatedEffortHours <= maxEffort,
            );

            // Sort by ROI descending
            filtered.sort((a, b) => b.roi - a.roi);

            if (opts.format === 'json') {
              const content = JSON.stringify(
                {
                  candidates: filtered,
                  summary: {
                    total: candidates.length,
                    filtered: filtered.length,
                    totalEffort: filtered.reduce((s, c) => s + c.estimatedEffortHours, 0),
                    avgRoi:
                      filtered.length > 0
                        ? filtered.reduce((s, c) => s + c.roi, 0) / filtered.length
                        : 0,
                  },
                },
                null,
                2,
              );
              if (opts.output) {
                writeFileSync(opts.output, content);
                output.success(`Written to ${opts.output}`);
              } else {
                console.log(content);
              }
              return;
            }

            if (opts.format === 'csv') {
              const csv = [
                'File,Module,Type,Description,Cognitive Load,Churn,Debt,Coupling,Effort (h),Risk Reduction,Frequency,ROI,Priority,Suggestion',
                ...filtered.map(
                  (c) =>
                    `"${c.file}","${c.module}","${c.type}","${c.description.replace(/"/g, '""')}",${c.cognitiveLoad.toFixed(3)},${c.churn},${c.debtCount},${c.coupling.toFixed(2)},${c.estimatedEffortHours},${c.riskReduction.toFixed(2)},${c.frequency},${c.roi.toFixed(2)},${c.priority},"${c.suggestion.replace(/"/g, '""')}"`,
                ),
              ].join('\n');

              if (opts.output) {
                writeFileSync(opts.output, csv);
                output.success(`Written to ${opts.output}`);
              } else {
                console.log(csv);
              }
              return;
            }

            // Text format
            if (filtered.length === 0) {
              output.info('No refactoring candidates match the criteria');
              return;
            }

            output.section(
              `Refactoring Opportunities (${filtered.length} of ${candidates.length} candidates)`,
            );

            for (const [i, c] of filtered.entries()) {
              const priorityIcon =
                c.priority === 'critical'
                  ? '🔴'
                  : c.priority === 'high'
                    ? '🟠'
                    : c.priority === 'medium'
                      ? '🟡'
                      : '🟢';
              const typeIcon =
                c.type === 'extract-function'
                  ? '✂️'
                  : c.type === 'extract-class'
                    ? '📦'
                    : c.type === 'inline'
                      ? '📥'
                      : c.type === 'rename'
                        ? '✏️'
                        : c.type === 'move'
                          ? '📦'
                          : '🔧';

              output.kv(
                `${i + 1}. ${priorityIcon} ${typeIcon} ${c.type} | ROI: ${c.roi.toFixed(2)}`,
                `${c.file} (${c.module})`,
              );
              output.kv('Description', c.description);
              output.kv(
                'Metrics',
                `Load: ${c.cognitiveLoad.toFixed(3)} | Churn: ${c.churn} | Debt: ${c.debtCount} | Coupling: ${c.coupling.toFixed(2)}`,
              );
              output.kv(
                'Effort/Risk/Freq',
                `Effort: ${c.estimatedEffortHours}h | Risk Reduction: ${(c.riskReduction * 100).toFixed(0)}% | Frequency: ${c.frequency}/mo`,
              );
              output.kv('Suggestion', c.suggestion);
            }

            // Summary
            const totalEffort = filtered.reduce((s, c) => s + c.estimatedEffortHours, 0);
            const avgRoi = filtered.reduce((s, c) => s + c.roi, 0) / filtered.length;
            const byPriority = filtered.reduce(
              (acc, c) => {
                acc[c.priority] = (acc[c.priority] || 0) + 1;
                return acc;
              },
              {} as Record<string, number>,
            );

            output.section('Summary');
            output.kv('Candidates shown', filtered.length);
            output.kv('Total effort', `${totalEffort}h`);
            output.kv('Average ROI', avgRoi.toFixed(2));
            output.kv(
              'By priority',
              Object.entries(byPriority)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', '),
            );
            output.kv(
              'Top candidate',
              filtered[0] ? `${filtered[0].file} (ROI: ${filtered[0].roi.toFixed(2)})` : 'None',
            );

            if (opts.output) {
              writeFileSync(opts.output, JSON.stringify({ candidates: filtered }, null, 2));
              output.success(`Written to ${opts.output}`);
            }
          });
        },
      ),
    );

  return roiCmd;
}

function generateRefactorCandidates(
  files: FileInfoForRefactor[],
  debtReport: DebtReportForRefactor,
): RefactorCandidate[] {
  const candidates: RefactorCandidate[] = [];
  // Real 90-day change frequency from git history; agent-touch fallback.
  const gitChurn = collectGitChurn(loadConfig().projectRoot, 90);
  // Second, shorter window feeds the acceleration (predictive) signal used
  // by createCandidate below (module-level so both scopes share it).
  recentChurnByFile = collectGitChurn(loadConfig().projectRoot, 30);

  for (const file of files) {
    const debtItems = debtReport.items.filter(
      (d) => d.filePath === file.relativePath || d.filePath === file.path,
    );
    const debtCount = debtItems.length;

    // Skip files with no debt and low cognitive load
    if (debtCount === 0 && file.cognitiveLoad < 0.2) continue;

    // Real change frequency from git history (falls back to agent-touch signal).
    const churn =
      gitChurn.get(String(file.relativePath).replace(/\\/g, '/'))?.count ??
      (file.agentTouched ? 1 : 0);

    // Calculate coupling (imports + imported by) - used in createCandidate
    const _coupling = Math.min(file.imports?.length || 0, 10) / 10;

    // Generate candidates based on file characteristics
    if (file.cognitiveLoad > 0.5 || file.lines > 300) {
      candidates.push(
        createCandidate(
          file,
          'extract-function',
          `Large function/file (${file.lines} lines, load: ${file.cognitiveLoad.toFixed(2)})`,
          Math.min(file.lines / 50, 8),
          0.3,
          churn,
          debtReport,
        ),
      );
    }

    if (file.cognitiveLoad > 0.7 && file.lines > 500) {
      candidates.push(
        createCandidate(
          file,
          'extract-class',
          `Large file with multiple responsibilities (${file.lines} lines)`,
          Math.min(file.lines / 100, 16),
          0.4,
          churn,
          debtReport,
        ),
      );
    }

    if (debtCount > 0) {
      const redundancyDebt = debtItems.filter((d) => d.type === 'redundancy');
      if (redundancyDebt.length > 0) {
        candidates.push(
          createCandidate(
            file,
            'simplify',
            `Code redundancy detected (${redundancyDebt.length} items)`,
            Math.min(redundancyDebt.length * 2, 8),
            0.35,
            churn,
            debtReport,
          ),
        );
      }

      const patternDrift = debtItems.filter((d) => d.type === 'pattern-drift');
      if (patternDrift.length > 0) {
        candidates.push(
          createCandidate(
            file,
            'rename',
            `Pattern drift detected - naming conventions violated`,
            Math.min(patternDrift.length, 4),
            0.25,
            churn,
            debtReport,
          ),
        );
      }
    }

    if (churn > 5 && file.cognitiveLoad > 0.3) {
      candidates.push(
        createCandidate(
          file,
          'move',
          `High churn file in wrong module - consider relocation`,
          4,
          0.3,
          churn,
          debtReport,
        ),
      );
    }

    if (file.lines < 50 && file.imports && file.imports.length > 5) {
      candidates.push(
        createCandidate(
          file,
          'inline',
          `Small file with many imports - consider inlining`,
          2,
          0.15,
          churn,
          debtReport,
        ),
      );
    }
  }

  return candidates;
}

/** Last-30d churn map shared with createCandidate for acceleration detection. */
let recentChurnByFile: Map<string, { count: number; authors: Set<string> }> | null = null;

function createCandidate(
  file: FileInfoForRefactor,
  type: RefactorCandidate['type'],
  description: string,
  effort: number,
  riskReduction: number,
  churn: number,
  debtReport: DebtReportForRefactor,
): RefactorCandidate {
  const frequency = churn;
  const roi = (riskReduction * frequency) / effort;

  // Predictive signal: is churn ACCELERATING? Compare last-30d against the
  // 90d window — a hot file heats up before it becomes a hotspot.
  let accelerating = false;
  if (recentChurnByFile) {
    const rel = file.relativePath.replace(/\\/g, '/');
    const c30 = recentChurnByFile.get(rel)?.count ?? 0;
    accelerating = churn > 2 && c30 >= Math.max(2, Math.ceil(churn * 0.6));
  }

  let suggestion = '';
  switch (type) {
    case 'extract-function':
      suggestion = 'Extract cohesive logic into separate functions to reduce cognitive load';
      break;
    case 'extract-class':
      suggestion = 'Split into multiple classes following Single Responsibility Principle';
      break;
    case 'simplify':
      suggestion = 'Remove duplicate code; extract shared utilities';
      break;
    case 'rename':
      suggestion = 'Align naming with project conventions';
      break;
    case 'move':
      suggestion = 'Move to more appropriate module to reduce coupling';
      break;
    case 'inline':
      suggestion = 'Inline small module into consumer to reduce indirection';
      break;
  }

  const debtItems = debtReport.items.filter(
    (d) => d.filePath === file.relativePath || d.filePath === file.path,
  );
  const debtCount = debtItems.length;
  const coupling = Math.min(file.imports?.length || 0, 10) / 10;

  return {
    file: file.relativePath,
    module: file.relativePath.split('/')[0] || 'root',
    type,
    description: accelerating ? `${description} ⏳ accelerating churn (30d vs 90d)` : description,
    cognitiveLoad: file.cognitiveLoad,
    churn: file.churn || 0,
    debtCount,
    coupling,
    estimatedEffortHours: Math.round(effort * 10) / 10,
    riskReduction,
    frequency: churn,
    roi: Math.round(((riskReduction * frequency) / effort) * 100) / 100,
    priority: roi > 3 ? 'critical' : roi > 1.5 ? 'high' : roi > 0.8 ? 'medium' : 'low',
    suggestion,
  };
}
