import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { asyncHandler, output, withService, loadConfig } from '@/cli/utils/shared.js';
import { confineToProject } from '@/mcp/tools/_shared.js';
import { buildFeatureMap, type FeatureMapReport } from '../../core/feature-map/feature-map.js';

interface FeatureMapOptions {
  format: string;
  limit: string;
  output?: string;
}

/** Register the feature-map subcommand without increasing graph command complexity. */
export function createFeatureMapCommand(): Command {
  return new Command('feature-map')
    .description('Map path-derived feature candidates and cross-feature import flows')
    .option('--format <fmt>', 'Output: text|json', 'text')
    .option('--limit <n>', 'Maximum feature candidates to return', '100')
    .option('-o, --output <file>', 'Write JSON to a file inside the project')
    .action(
      asyncHandler(async (rawOptions: FeatureMapOptions, command: Command) => {
        const options = inheritGraphOptions(rawOptions, command);
        if (!['text', 'json'].includes(options.format)) {
          throw new Error(`--format must be one of text, json: ${options.format}`);
        }
        const limit = Number(options.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
          throw new Error(`--limit must be an integer between 1 and 1000: ${options.limit}`);
        }
        const root = loadConfig().projectRoot;
        await withService([], async (ctx) => {
          const report = buildFeatureMap(ctx.kg, limit);
          const payload = {
            success: true,
            action: 'feature-map',
            ...report,
            nextAction:
              'Treat labels as path-derived candidates; confirm business semantics from source before making architectural decisions.',
          };
          if (options.output) {
            const target = confineToProject(options.output, root);
            writeFileSync(target, JSON.stringify(payload, null, 2));
            output.success(`Feature map written to ${target}`);
          } else if (options.format === 'json') {
            output.json(payload);
          } else {
            printFeatureMap({ ...report, nextAction: payload.nextAction });
          }
        });
      }),
    );
}

function printFeatureMap(payload: FeatureMapReport & { nextAction: string }): void {
  output.section('Feature Map');
  output.kv('Source files', payload.totalSourceFiles);
  output.kv('Feature candidates', payload.totalFeatures);
  for (const feature of payload.features) {
    output.info(
      `${feature.label} [${feature.key}] — ${feature.files.length} files, ${feature.testFiles.length} tests, confidence ${Math.round(feature.confidence * 100)}%`,
    );
    output.info(`  entries: ${feature.entryFiles.join(', ')}`);
    if (feature.dependencies.length > 0)
      output.info(`  depends on: ${feature.dependencies.join(', ')}`);
    if (feature.dependents.length > 0) output.info(`  used by: ${feature.dependents.join(', ')}`);
  }
  for (const flow of payload.flows) {
    output.info(`Flow ${flow.from} -> ${flow.to} (${flow.importCount} imports)`);
    output.info(`  examples: ${flow.examples.join('; ')}`);
  }
  for (const limitation of payload.limitations) output.warn(`Limitation: ${limitation}`);
  output.info(payload.nextAction);
}

/** Commander assigns duplicate parent options to graph, not its child. */
function inheritGraphOptions<T extends FeatureMapOptions>(options: T, command: Command): T {
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
