import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';

export function createScaleCommand(): Command {
  return new Command('scale')
    .description('Show project scale and coverage report')
    .option('-j, --json', 'Output as JSON')
    .action(
      asyncHandler(async (opts: { json?: boolean }) => {
        await withService(['scale'], async (_ctx, services) => {
          const scale = services.scale!;
          const report = scale.getScaleReport();

          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  totalFiles: report.totalFiles,
                  totalLines: report.totalLines,
                  totalBytes: report.totalBytes,
                  agentCoverage: report.agentCoverage,
                  avgCognitiveLoad: report.avgCognitiveLoad,
                  languages: report.languages,
                  modules: report.modules.map((m) => ({
                    path: m.path,
                    name: m.name,
                    fileCount: m.fileCount,
                    totalBytes: m.totalBytes,
                    cognitiveLoad: m.cognitiveLoad,
                    agentCoverage: m.agentCoverage,
                  })),
                  topHotspots: report.topHotspots.map((f) => ({
                    path: f.relativePath,
                    cognitiveLoad: f.cognitiveLoad,
                    agentTouched: f.agentTouched,
                  })),
                  uncoveredFiles: report.uncoveredFiles.map((f) => ({
                    path: f.relativePath,
                    cognitiveLoad: f.cognitiveLoad,
                  })),
                },
                null,
                2,
              ),
            );
            return;
          }

          output.section('Scale Report');
          output.kv('Files', report.totalFiles);
          output.kv('Lines of code', report.totalLines);
          output.kv('Agent coverage', `${(report.agentCoverage * 100).toFixed(1)}%`);
          output.kv('Avg cognitive load', report.avgCognitiveLoad.toFixed(3));

          output.section('Modules');
          for (const mod of report.modules) {
            const bar =
              '█'.repeat(Math.floor(mod.agentCoverage * 10)) +
              '░'.repeat(10 - Math.floor(mod.agentCoverage * 10));
            output.kv(
              `  ${bar} ${mod.name}`,
              `${mod.fileCount} files, load=${mod.cognitiveLoad.toFixed(2)}`,
            );
          }

          output.section('Top hotspots');
          for (const f of report.topHotspots.slice(0, 5)) {
            output.kv(`  ${f.relativePath}`, `load: ${f.cognitiveLoad.toFixed(3)}`);
          }

          output.section('Uncovered files (need attention)');
          for (const f of report.uncoveredFiles.slice(0, 5)) {
            output.kv(`  ${f.relativePath}`, `load: ${f.cognitiveLoad.toFixed(3)}`);
          }
        });
      }),
    );
}
