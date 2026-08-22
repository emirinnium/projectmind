import { Command } from 'commander';
import { withService, asyncHandler, output, formatGenomeScore } from '@/cli/utils/shared.js';

export function createReportCommand(): Command {
  return new Command('report')
    .description('Generate full coherence + debt report')
    .option('-j, --json', 'Output as JSON')
    .action(asyncHandler(async (opts: { json?: boolean }) => {
      await withService(['scale', 'debt'], async (_ctx, services) => {
        const scale = services.scale!;
        const debt = services.debt!;
        const genome = debt.computeGenome();
        const scaleReport = scale.getScaleReport();
        const debtReport = debt.getReport();

        if (opts.json) {
          console.log(JSON.stringify({
            totalFiles: scaleReport.totalFiles,
            totalLines: scaleReport.totalLines,
            totalBytes: scaleReport.totalBytes,
            agentCoverage: scaleReport.agentCoverage,
            avgCognitiveLoad: scaleReport.avgCognitiveLoad,
            languages: scaleReport.languages,
            modules: scaleReport.modules.map(m => ({
              path: m.path,
              fileCount: m.fileCount,
              cognitiveLoad: m.cognitiveLoad,
              agentCoverage: m.agentCoverage,
            })),
            topHotspots: scaleReport.topHotspots.map(f => ({
              path: f.relativePath,
              cognitiveLoad: f.cognitiveLoad,
              agentTouched: f.agentTouched,
            })),
            debtItems: [
              { severity: 'high', count: debtReport.bySeverity.high },
              { severity: 'medium', count: debtReport.bySeverity.medium },
              { severity: 'low', count: debtReport.bySeverity.low },
            ],
            debtTotal: debtReport.totalItems,
            genomeScore: genome.coherenceScore,
          }, null, 2));
          return;
        }

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