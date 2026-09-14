import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { EvidenceLedger, computeIndexedGraphHash } from '@/core/ledger/evidence-ledger.js';
import { logger } from '@/utils/logger.js';

export function createScanCommand(): Command {
  return new Command('scan')
    .description('Scan project and build/update knowledge graph')
    .option('-r, --root <path>', 'Root directory (defaults to configured project root)')
    .option('--project <id>', 'Use a registered project ID from the shared project store')
    .option('-p, --profile', 'Show performance profiling info')
    .option('-f, --full', 'Force full scan (bypass incremental)')
    .option('-j, --json', 'Output as JSON')
    .action(
      asyncHandler(
        async (opts: {
          root?: string;
          project?: string;
          profile?: boolean;
          full?: boolean;
          json?: boolean;
        }) => {
          if (opts.root && opts.project) {
            throw new Error('Use either --root or --project, not both.');
          }
          const requestedProjectId = opts.project ? Number.parseInt(opts.project, 10) : undefined;
          if (
            opts.project !== undefined &&
            (!Number.isSafeInteger(requestedProjectId) || requestedProjectId! <= 0)
          ) {
            throw new Error(`Project ID must be a positive integer: ${opts.project}`);
          }
          await withService(
            ['scale'],
            async (ctx, services) => {
              const scale = services.scale!;
              let root = opts.root;
              if (requestedProjectId !== undefined) {
                const switched = ctx.kg.switchProject(requestedProjectId);
                if (!switched.success || !switched.project) {
                  throw new Error(switched.error || `Project ${requestedProjectId} was not found.`);
                }
                root = switched.project.rootPath;
              }
              // Machine-readable mode must keep stdout parseable. Human progress
              // remains available on stderr for callers that want diagnostics.
              if (opts.json) {
                process.stderr.write(
                  `Scanning project at: ${root ?? 'configured project root'}${opts.full ? ' (full scan)' : ' (incremental)'}\n`,
                );
              } else {
                output.info(
                  `Scanning project at: ${root ?? 'configured project root'}${opts.full ? ' (full scan)' : ' (incremental)'}`,
                );
              }
              let result: {
                scanned: number;
                errors: number;
                totalFiles: number;
                skippedFiles: number;
                skippedPaths: string[];
              };
              let dependencyFiles: number | undefined;
              let dependencyDepth: number | undefined;
              if (opts.profile) {
                const profile = await scale.scanProjectWithProfile(root, opts.full);
                dependencyFiles = profile.dependencyFiles;
                dependencyDepth = profile.dependencyDepth;
                result = {
                  scanned: profile.scannedFiles,
                  errors: profile.errorFiles,
                  totalFiles: profile.totalFiles,
                  skippedFiles: profile.skippedFiles,
                  skippedPaths: profile.skippedPaths,
                };
                if (opts.json) {
                  process.stderr.write(
                    `Profile: ${profile.scannedFiles}/${profile.totalFiles} files, ${profile.errorFiles} errors, ${profile.durationMs}ms\n`,
                  );
                } else {
                  output.section('Scan Complete');
                  output.kv('Files found', profile.totalFiles);
                  output.kv('Scanned', profile.scannedFiles);
                  output.kv('Skipped (oversized)', profile.skippedFiles);
                  output.kv('Errors', profile.errorFiles);
                  output.kv('Duration', `${profile.durationMs}ms`);
                  output.kv('Throughput', `${profile.filesPerSecond} files/sec`);
                  output.kv('Memory delta', `${profile.memoryUsedMB} MB`);
                  if ((profile.dependencyFiles ?? 0) > 0) {
                    output.kv(
                      'Dependency refresh',
                      `${profile.dependencyFiles} dependent file(s) at depth ${profile.dependencyDepth ?? 0}`,
                    );
                  }

                  if (profile.errors.length > 0) {
                    output.section('Errors');
                    profile.errors.slice(0, 10).forEach((e: string) => output.warn(`  ${e}`));
                    if (profile.errors.length > 10) {
                      output.warn(`  ... and ${profile.errors.length - 10} more errors`);
                    }
                  }
                  if (profile.skippedPaths.length > 0) {
                    output.section('Skipped files');
                    profile.skippedPaths
                      .slice(0, 10)
                      .forEach((file: string) => output.warn(`  ${file}`));
                    if (profile.skippedPaths.length > 10) {
                      output.warn(
                        `  ... and ${profile.skippedPaths.length - 10} more oversized files`,
                      );
                    }
                  }
                }
              } else {
                result = await scale.scanProject(root, opts.full);
                const summary = `Scanned: ${result.scanned} files, ${result.errors} errors${result.skippedFiles > 0 ? ` (${result.skippedFiles} oversized files skipped)` : ''}`;
                if (opts.json) process.stderr.write(`${summary}\n`);
                else output.info(summary);
              }

              let ledger: { recordId: number; recordHash: string } | undefined;
              if (ctx.db) {
                try {
                  const record = new EvidenceLedger(ctx.db, ctx.kg.getCurrentProjectId()).append({
                    eventType: 'scan',
                    toolName: 'pm scan',
                    input: opts,
                    result,
                    graphHash: computeIndexedGraphHash(ctx.kg),
                    summary: {
                      success: result.errors === 0,
                      scanned: result.scanned,
                      errors: result.errors,
                      totalFiles: result.totalFiles,
                    },
                  });
                  ledger = { recordId: record.id, recordHash: record.recordHash };
                } catch (error) {
                  logger.warn('Evidence ledger append failed after CLI scan completion.', {
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }

              if (opts.json) {
                const report = scale.getScaleReport();
                output.json({
                  protocolVersion: 1,
                  scanned: result.scanned,
                  errors: result.errors,
                  totalFiles: report.totalFiles,
                  skippedFiles: result.skippedFiles,
                  skippedPaths: result.skippedPaths,
                  ...(dependencyFiles !== undefined ? { dependencyFiles, dependencyDepth } : {}),
                  agentCoverage: report.agentCoverage,
                  avgCognitiveLoad: report.avgCognitiveLoad,
                  ...(ledger ? { evidenceLedger: ledger } : {}),
                });
              } else {
                const report = scale.getScaleReport();
                output.kv('Total files', report.totalFiles);
                output.kv('Agent coverage', `${(report.agentCoverage * 100).toFixed(1)}%`);
                output.kv('Avg cognitive load', report.avgCognitiveLoad.toFixed(3));
                if (ledger) output.kv('Evidence ledger record', `#${ledger.recordId}`);
              }
            },
            opts.project ? undefined : opts.root,
          );
        },
      ),
    );
}
