import { Command } from 'commander';
import { withService, asyncHandler, output, loadConfig } from '@/cli/utils/shared.js';
import { writeFileSync } from 'node:fs';
import { renderModuleSvg, renderModulePng } from './graph-render.js';
import { createFeatureMapCommand } from './graph-feature-map.js';
import { confineToProject } from '@/mcp/tools/_shared.js';
import {
  diffGraphSnapshots,
  readGraphSnapshot,
  verifyGraphSnapshot,
  writeGraphSnapshot,
} from '../../core/snapshots/graph-snapshot.js';

export function createGraphCommand(): Command {
  const graphCmd = new Command('graph')
    .description('Show module dependency graph (mermaid|svg|png|json)')
    .option('--format <fmt>', 'Output format: mermaid|svg|png|json', 'mermaid')
    .option('-o, --output <file>', 'Write to file')
    .action(
      asyncHandler(async (opts: { format: string; output?: string }, command: Command) => {
        opts = inheritGraphOptions(opts, command);
        await withService(['scale'], async (_ctx, services) => {
          const scale = services.scale!;
          const projectRoot = loadConfig().projectRoot;

          const report = scale.getScaleReport();
          const format = opts.format || 'mermaid';
          if (!['mermaid', 'svg', 'png', 'json'].includes(format)) {
            throw new Error(`--format must be one of mermaid, svg, png, json: ${format}`);
          }
          if (format === 'png') {
            const target = confineToProject(opts.output || 'projectmind-graph.png', projectRoot);
            const buf = renderModulePng(report);
            writeFileSync(target, buf);
            output.success(`Graph written to ${target}`);
            return;
          }

          if (format === 'json') {
            const content = JSON.stringify(report, null, 2);
            if (opts.output) {
              const target = confineToProject(opts.output, projectRoot);
              writeFileSync(target, content);
              output.success(`Graph written to ${target}`);
            } else {
              output.raw(content);
            }
          } else if (format === 'svg') {
            const content = renderModuleSvg(report);
            if (opts.output) {
              const target = confineToProject(opts.output, projectRoot);
              writeFileSync(target, content);
              output.success(`Graph written to ${target}`);
            } else {
              output.raw(content);
            }
          } else {
            const lines = ['graph TD'];

            for (const mod of report.modules) {
              const id = mod.path.replace(/[^a-zA-Z0-9]/g, '_');
              lines.push(`  ${id}[${mod.path} (${mod.fileCount} files)]`);
            }

            for (const mod of report.modules) {
              const modId = mod.path.replace(/[^a-zA-Z0-9]/g, '_');
              for (const file of mod.files || []) {
                const fileId = file.path.replace(/[^a-zA-Z0-9]/g, '_');
                lines.push(`  ${fileId} --> ${modId}`);
              }
            }

            const content = lines.join('\n');

            if (opts.output) {
              const target = confineToProject(opts.output, projectRoot);
              writeFileSync(target, content);
              output.success(`Graph written to ${target}`);
            } else {
              output.raw(content);
            }
          }

          // Artifact formats must remain byte-for-byte consumable on stdout.
          // Diagnostics are intentionally sent to stderr.
          process.stderr.write(
            `Modules: ${report.modules.length}; Total files: ${report.totalFiles}\n`,
          );
        });
      }),
    );

  graphCmd
    .command('circular')
    .description('Find circular dependencies')
    .option('--format <fmt>', 'Output: text|mermaid|json', 'text')
    .option('-o, --output <file>', 'Write to file')
    .action(
      asyncHandler(async (opts: { format: string; output?: string }, command: Command) => {
        opts = inheritGraphOptions(opts, command);
        if (!['text', 'mermaid', 'json'].includes(opts.format)) {
          throw new Error(`--format must be one of text, mermaid, json: ${opts.format}`);
        }
        await withService(['scale'], async (ctx, services) => {
          const scale = services.scale!;
          const report = scale.getScaleReport();
          const cycles = ctx.kg.findCircularDependencies();
          const payload = {
            modulesAnalyzed: report.modules.length,
            totalFiles: report.totalFiles,
            count: cycles.length,
            cycles,
          };

          if (opts.format === 'json') {
            output.json(payload);
          } else if (opts.format === 'mermaid') {
            const lines = ['graph TD'];
            for (const [index, cycle] of cycles.entries()) {
              for (let i = 0; i < cycle.length; i++) {
                const from = cycle[i];
                const to = cycle[(i + 1) % cycle.length];
                lines.push(`  ${nodeId(from)} --> ${nodeId(to)}`);
                lines.push(`  ${nodeId(from)}["${escapeMermaid(from)}"]`);
                lines.push(`  ${nodeId(to)}["${escapeMermaid(to)}"]`);
              }
              lines.push(`  %% cycle ${index + 1}`);
            }
            if (cycles.length === 0) lines.push('  %% No circular dependencies detected');
            const content = lines.join('\n');
            if (opts.output)
              writeFileSync(confineToProject(opts.output, loadConfig().projectRoot), content);
            else output.raw(content);
          } else {
            output.section('Circular Dependency Check');
            output.kv('Modules analyzed', payload.modulesAnalyzed);
            output.kv('Total files', payload.totalFiles);
            if (cycles.length > 0) {
              output.warn(`Found ${cycles.length} circular dependencies:`);
              cycles.slice(0, 20).forEach((cycle) => output.info(`  ${cycle.join(' -> ')}`));
            } else output.info('No circular dependencies detected.');
          }
        });
      }),
    );

  graphCmd
    .command('snapshot')
    .description('Capture a deterministic, portable snapshot of the indexed graph')
    .option('-o, --output <file>', 'Snapshot path inside the project')
    .option('--format <fmt>', 'Output: text|json', 'text')
    .action(
      asyncHandler(async (opts: { output?: string; format: string }, command: Command) => {
        opts = inheritGraphOptions(opts, command);
        if (!['text', 'json'].includes(opts.format)) {
          throw new Error(`--format must be one of text, json: ${opts.format}`);
        }
        const root = loadConfig().projectRoot;
        await withService([], async (ctx) => {
          const result = await writeGraphSnapshot(
            ctx.kg,
            root,
            opts.output ? confineToProject(opts.output, root) : undefined,
          );
          const payload = {
            success: true,
            path: result.path,
            createdAt: result.snapshot.createdAt,
            graphHash: result.snapshot.graphHash,
            project: result.snapshot.project,
            counts: {
              files: result.snapshot.files.length,
              imports: result.snapshot.imports.length,
              calls: result.snapshot.calls.length,
            },
            nextAction:
              'Use graph verify <snapshot> to detect graph drift before relying on derived analysis.',
          };
          if (opts.format === 'json') output.json(payload);
          else {
            output.section('Graph Snapshot');
            output.kv('Path', payload.path);
            output.kv('Graph hash', payload.graphHash);
            output.kv('Files', payload.counts.files);
            output.kv('Imports', payload.counts.imports);
            output.kv('Calls', payload.counts.calls);
            output.info(payload.nextAction);
          }
        });
      }),
    );

  graphCmd.addCommand(createFeatureMapCommand());

  graphCmd
    .command('verify <snapshot>')
    .description('Verify a saved graph snapshot against the active indexed graph')
    .option('--format <fmt>', 'Output: text|json', 'text')
    .option('--fail-on-diff', 'Exit with code 2 when the graph differs')
    .action(
      asyncHandler(
        async (
          snapshotPath: string,
          opts: { format: string; failOnDiff?: boolean },
          command: Command,
        ) => {
          opts = { ...opts, format: inheritGraphOptions(opts, command).format };
          if (!['text', 'json'].includes(opts.format)) {
            throw new Error(`--format must be one of text, json: ${opts.format}`);
          }
          const root = loadConfig().projectRoot;
          const target = confineToProject(snapshotPath, root);
          const snapshot = await readGraphSnapshot(target);
          await withService([], async (ctx) => {
            const verification = verifyGraphSnapshot(snapshot, ctx.kg);
            const payload = {
              success: true,
              snapshot: target,
              ...verification,
              nextAction: verification.match
                ? 'The indexed graph matches the snapshot; refresh it after source or trace changes.'
                : 'Run projectmind scan, create a new snapshot, and re-check derived analysis before trusting it.',
            };
            if (opts.failOnDiff && !verification.match) process.exitCode = 2;
            if (opts.format === 'json') output.json(payload);
            else printSnapshotVerification(payload);
          });
        },
      ),
    );

  graphCmd
    .command('diff <left> <right>')
    .description('Explain file, import, and runtime-call differences between two snapshots')
    .option('--format <fmt>', 'Output: text|json', 'text')
    .action(
      asyncHandler(
        async (leftPath: string, rightPath: string, opts: { format: string }, command: Command) => {
          opts = { ...opts, format: inheritGraphOptions(opts, command).format };
          if (!['text', 'json'].includes(opts.format)) {
            throw new Error(`--format must be one of text, json: ${opts.format}`);
          }
          const root = loadConfig().projectRoot;
          const leftTarget = confineToProject(leftPath, root);
          const rightTarget = confineToProject(rightPath, root);
          const [left, right] = await Promise.all([
            readGraphSnapshot(leftTarget),
            readGraphSnapshot(rightTarget),
          ]);
          const diff = diffGraphSnapshots(left, right);
          const payload = {
            success: true,
            left: leftTarget,
            right: rightTarget,
            leftHash: left.graphHash,
            rightHash: right.graphHash,
            ...diff,
            nextAction:
              diff.addedFiles.length || diff.removedFiles.length || diff.changedFiles.length
                ? 'Review changed files and run projectmind scan before using the newer graph for impact decisions.'
                : 'No file-content graph changes detected; inspect import/call differences if present.',
          };
          if (opts.format === 'json') output.json(payload);
          else printSnapshotDiff(payload);
        },
      ),
    );

  return graphCmd;
}

function printSnapshotVerification(payload: {
  match: boolean;
  projectMatch: boolean;
  snapshotHash: string;
  currentHash: string;
  addedFiles: string[];
  removedFiles: string[];
  changedFiles: string[];
  addedImports: unknown[];
  removedImports: unknown[];
  addedCalls: unknown[];
  removedCalls: unknown[];
  limitations: string[];
  nextAction: string;
}): void {
  output.section('Graph Snapshot Verification');
  output.kv('Match', payload.match ? 'yes — graph unchanged' : 'no — graph drift detected');
  output.kv('Project identity', payload.projectMatch ? 'same' : 'different');
  output.kv('Snapshot hash', payload.snapshotHash);
  output.kv('Current hash', payload.currentHash);
  printSnapshotDiffCounts(payload);
  for (const limitation of payload.limitations) output.warn(`Limitation: ${limitation}`);
  output.info(payload.nextAction);
}

function printSnapshotDiff(payload: {
  leftHash: string;
  rightHash: string;
  projectChanged: boolean;
  addedFiles: string[];
  removedFiles: string[];
  changedFiles: string[];
  addedImports: unknown[];
  removedImports: unknown[];
  addedCalls: unknown[];
  removedCalls: unknown[];
  nextAction: string;
}): void {
  output.section('Graph Snapshot Diff');
  output.kv('Left hash', payload.leftHash);
  output.kv('Right hash', payload.rightHash);
  output.kv('Project identity changed', payload.projectChanged ? 'yes' : 'no');
  printSnapshotDiffCounts(payload);
  for (const path of payload.addedFiles.slice(0, 20)) output.info(`Added file: ${path}`);
  for (const path of payload.removedFiles.slice(0, 20)) output.warn(`Removed file: ${path}`);
  for (const path of payload.changedFiles.slice(0, 20)) output.info(`Changed file: ${path}`);
  output.info(payload.nextAction);
}

function printSnapshotDiffCounts(payload: {
  addedFiles: string[];
  removedFiles: string[];
  changedFiles: string[];
  addedImports: unknown[];
  removedImports: unknown[];
  addedCalls: unknown[];
  removedCalls: unknown[];
}): void {
  output.kv('Added files', payload.addedFiles.length);
  output.kv('Removed files', payload.removedFiles.length);
  output.kv('Changed files', payload.changedFiles.length);
  output.kv('Added imports', payload.addedImports.length);
  output.kv('Removed imports', payload.removedImports.length);
  output.kv('Added calls', payload.addedCalls.length);
  output.kv('Removed calls', payload.removedCalls.length);
}

/** Commander assigns duplicate parent options to `graph`, not its child. */
export function inheritGraphOptions<T extends { format: string; output?: string }>(
  options: T,
  command: Command,
): T {
  const parent = command.parent;
  if (!parent) return options;
  const inherited = { ...options };
  const formatSource = parent.getOptionValueSource('format');
  if (formatSource !== undefined && formatSource !== 'default') {
    inherited.format = String(parent.getOptionValue('format'));
  }
  if (parent.getOptionValueSource('output') !== undefined) {
    const outputPath = parent.getOptionValue('output');
    inherited.output = typeof outputPath === 'string' ? outputPath : undefined;
  }
  return inherited;
}

function nodeId(path: string): string {
  return `n_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

function escapeMermaid(value: string): string {
  return value.replace(/"/g, '#quot;').replace(/\r?\n/g, ' ');
}
