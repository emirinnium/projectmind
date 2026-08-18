import { Command } from 'commander';
import { withServices, asyncHandler, output, formatGenomeScore } from '../utils/shared.js';

export function createReportCommand(): Command {
  return new Command('report')
    .description('Generate full coherence + debt report')
    .action(asyncHandler(async () => {
      await withServices(['scale', 'debt', 'coherence'], async (_ctx, services) => {
        const scaleReport = services.scale.getScaleReport();
        const debtReport = services.debt.getReport();
        const genome = services.debt.computeGenome();

        output.section('ProjectMind Report');

        output.section('Scale');
        output.kv('Total files', scaleReport.totalFiles);
        output.kv('Total bytes', `${(scaleReport.totalBytes / 1024).toFixed(1)} KB`);
        output.kv('Total lines', scaleReport.totalLines);
        const langStr = Object.entries(scaleReport.languages).map(([k, v]) => `${k}(${(v as { files: number }).files})`).join(', ');
        output.kv('Languages', langStr);
        output.kv('Agent coverage', `${(scaleReport.agentCoverage * 100).toFixed(1)}%`);

        output.section('Modules');
        for (const mod of scaleReport.modules) {
          output.kv(`  ${mod.path}`, `${mod.fileCount} files, load=${mod.cognitiveLoad.toFixed(3)}, coverage=${(mod.agentCoverage * 100).toFixed(0)}%`);
        }

        output.section('Debt');
        output.kv('Total debt items', debtReport.totalItems);
        output.kv('  High', debtReport.bySeverity.high);
        output.kv('  Medium', debtReport.bySeverity.medium);
        output.kv('  Low', debtReport.bySeverity.low);

        output.section('Coherence Genome');
        output.kv('Score', formatGenomeScore(genome.coherenceScore));

        if (debtReport.items.length > 0) {
          output.section('Top Debt Items');
          for (const item of debtReport.items.slice(0, 5)) {
            output.kv(`  [${item.severity.toUpperCase()}] ${item.type}`, item.description);
          }
        }
      });
    }));
}