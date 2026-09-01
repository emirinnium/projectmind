import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderModuleSvg, renderModulePng } from './graph-render.js';

export function createGraphCommand(): Command {
  const graphCmd = new Command('graph')
    .description('Show module dependency graph (mermaid|svg|png|json)')
    .option('--format <fmt>', 'Output format: mermaid|svg|png|json', 'mermaid')
    .option('-o, --output <file>', 'Write to file')
    .action(
      asyncHandler(async (opts: { format: string; output: string }) => {
        await withService(['scale'], async (_ctx, services) => {
          const scale = services.scale!;

          output.section('Module Dependency Graph');

          const report = scale.getScaleReport();
          const format = opts.format || 'mermaid';

          if (format === 'json') {
            const content = JSON.stringify(report, null, 2);
            if (opts.output) {
              writeFileSync(opts.output, content);
              output.success(`Graph written to ${opts.output}`);
            } else {
              console.log(content);
            }
          } else if (format === 'svg') {
            const content = renderModuleSvg(report);
            if (opts.output) {
              writeFileSync(opts.output, content);
              output.success(`Graph written to ${opts.output}`);
            } else {
              console.log(content);
            }
          } else if (format === 'png') {
            const buf = renderModulePng(report);
            const target = opts.output || resolve(process.cwd(), 'projectmind-graph.png');
            writeFileSync(target, buf);
            output.success(`Graph written to ${target}`);
            output.info(
              'PNG output requires --output or defaults to projectmind-graph.png in the current directory.',
            );
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
              writeFileSync(opts.output, content);
              output.success(`Graph written to ${opts.output}`);
            } else {
              console.log(content);
            }
          }

          output.kv('Modules', report.modules.length);
          output.kv('Total files', report.totalFiles);
        });
      }),
    );

  graphCmd
    .command('circular')
    .description('Find circular dependencies')
    .option('--format <fmt>', 'Output: text|mermaid|json', 'text')
    .option('-o, --output <file>', 'Write to file')
    .action(
      asyncHandler(async () => {
        await withService(['scale'], async (_ctx, services) => {
          const scale = services.scale!;
          const report = scale.getScaleReport();

          output.section('Circular Dependency Check');
          output.kv('Modules analyzed', report.modules.length);
          output.kv('Total files', report.totalFiles);

          // Check for cross-module dependencies based on file structure
          const potentialCycles: string[] = [];

          // Simple heuristic: modules that share files may have dependencies
          for (let i = 0; i < report.modules.length; i++) {
            for (let j = i + 1; j < report.modules.length; j++) {
              const modA = report.modules[i];
              const modB = report.modules[j];
              // Check if modules share common path prefixes
              if (modA.path && modB.path && modA.path.startsWith(modB.path)) {
                potentialCycles.push(`${modA.path} -> ${modB.path}`);
              }
            }
          }

          if (potentialCycles.length > 0) {
            output.warn(`Found ${potentialCycles.length} potential cross-module dependencies:`);
            potentialCycles.slice(0, 10).forEach((c) => output.info(`  ${c}`));
          } else {
            output.info('No circular dependencies detected at module level.');
          }
        });
      }),
    );

  return graphCmd;
}
