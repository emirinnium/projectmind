import { Command } from 'commander';
import { withScale, asyncHandler, output } from '../utils/shared.js';

export function createScaleCommand(): Command {
  return new Command('scale')
    .description('Show project scale and coverage report')
    .action(asyncHandler(async () => {
      await withScale(async (_ctx, scale) => {
        const report = scale.getScaleReport();

        output.section('Scale Report');
        output.kv('Files', report.totalFiles);
        output.kv('Lines of code', report.totalLines);
        output.kv('Agent coverage', `${(report.agentCoverage * 100).toFixed(1)}%`);
        output.kv('Avg cognitive load', report.avgCognitiveLoad.toFixed(3));

        output.section('Modules');
        for (const mod of report.modules) {
          const bar = '█'.repeat(Math.floor(mod.agentCoverage * 10)) + '░'.repeat(10 - Math.floor(mod.agentCoverage * 10));
          output.kv(`  ${bar} ${mod.name}`, `${mod.fileCount} files, load=${mod.cognitiveLoad.toFixed(2)}`);
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
    }));
}