import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { writeFileSync } from 'node:fs';
import { type FileInfoForRefactor, generateRefactorCandidates } from './refactor-roi-engine.js';

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
                output.raw(content);
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
                output.raw(csv);
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
