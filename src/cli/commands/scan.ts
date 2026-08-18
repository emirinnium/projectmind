import { Command } from 'commander';
import { withScale, asyncHandler, output } from '../utils/shared.js';

export function createScanCommand(): Command {
  return new Command('scan')
    .description('Scan project and build/update knowledge graph')
    .option('-r, --root <path>', 'Root directory', process.cwd())
    .option('-p, --profile', 'Show performance profiling info')
    .action(asyncHandler(async (opts: { root: string; profile?: boolean }) => {
      await withScale(async (_ctx, scale) => {
        output.info(`Scanning project at: ${opts.root}`);
        let result;
        if (opts.profile) {
          const profile = await scale.scanProjectWithProfile(opts.root);
          output.section('Scan Complete');
          output.kv('Files found', profile.totalFiles);
          output.kv('Scanned', profile.scannedFiles);
          output.kv('Errors', profile.errorFiles);
          output.kv('Duration', `${profile.durationMs}ms`);
          output.kv('Throughput', `${profile.filesPerSecond} files/sec`);
          output.kv('Memory delta', `${profile.memoryUsedMB} MB`);
          
          if (profile.errors.length > 0) {
            output.section('Errors');
            profile.errors.slice(0, 10).forEach((e: string) => output.warn(`  ${e}`));
            if (profile.errors.length > 10) {
              output.warn(`  ... and ${profile.errors.length - 10} more errors`);
            }
          }
        } else {
          result = await scale.scanProject(opts.root);
          output.info(`Scanned: ${result.scanned} files, ${result.errors} errors`);
        }

        const report = scale.getScaleReport();
        output.kv('Total files', report.totalFiles);
        output.kv('Agent coverage', `${(report.agentCoverage * 100).toFixed(1)}%`);
        output.kv('Avg cognitive load', report.avgCognitiveLoad.toFixed(3));
      });
    }));
}