import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';

export function createScanCommand(): Command {
  return new Command('scan')
    .description('Scan project and build/update knowledge graph')
    .option('-r, --root <path>', 'Root directory', process.cwd())
    .option('-p, --profile', 'Show performance profiling info')
    .option('-f, --full', 'Force full scan (bypass incremental)')
    .option('-j, --json', 'Output as JSON')
    .action(
      asyncHandler(
        async (opts: { root: string; profile?: boolean; full?: boolean; json?: boolean }) => {
          await withService(
            ['scale'],
            async (_ctx, services) => {
              const scale = services.scale!;
              output.info(
                `Scanning project at: ${opts.root}${opts.full ? ' (full scan)' : ' (incremental)'}`,
              );
              let result;
              if (opts.profile) {
                const profile = await scale.scanProjectWithProfile(opts.root, opts.full);
                output.section('Scan Complete');
                output.kv('Files found', profile.totalFiles);
                output.kv('Scanned', profile.scannedFiles);
                output.kv('Skipped', profile.totalFiles - profile.scannedFiles);
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
                result = await scale.scanProject(opts.root, opts.full);
                const skipped = result.totalFiles - result.scanned;
                output.info(
                  `Scanned: ${result.scanned} files, ${result.errors} errors${skipped > 0 ? ` (${skipped} unchanged, skipped)` : ''}`,
                );
              }

              if (opts.json) {
                const report = scale.getScaleReport();
                console.log(
                  JSON.stringify(
                    {
                      scanned: result?.scanned ?? 0,
                      errors: result?.errors ?? 0,
                      totalFiles: report.totalFiles,
                      agentCoverage: report.agentCoverage,
                      avgCognitiveLoad: report.avgCognitiveLoad,
                    },
                    null,
                    2,
                  ),
                );
              } else {
                const report = scale.getScaleReport();
                output.kv('Total files', report.totalFiles);
                output.kv('Agent coverage', `${(report.agentCoverage * 100).toFixed(1)}%`);
                output.kv('Avg cognitive load', report.avgCognitiveLoad.toFixed(3));
              }
            },
            opts.root,
          );
        },
      ),
    );
}
