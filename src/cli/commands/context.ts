import { Command } from 'commander';
import { withScale, asyncHandler, output } from '../utils/shared.js';

export function createContextCommand(): Command {
  return new Command('context')
    .description('Get relevant context for a file')
    .argument('<file>', 'File path')
    .action(asyncHandler(async (filePath: string) => {
      await withScale(async (_ctx, scale) => {
        const kg = scale['kg'];
        const file = kg.getFileByPath(filePath);
        if (!file) {
          output.warn(`File not found in knowledge graph: ${filePath}`);
          output.info('Run "projectmind scan" first.');
          return;
        }

        output.section(`Context for: ${file.relativePath}`);
        output.kv('Language', file.language);
        output.kv('Size', `${file.sizeBytes} bytes`);
        output.kv('Cognitive load', file.cognitiveLoad.toFixed(3));
        output.kv('Agent touched', file.agentTouched ? 'yes' : 'no');

        const uncovered = scale.getUncoveredModules();
        if (uncovered.length > 0) {
          output.section('Uncovered modules nearby');
          for (const m of uncovered.slice(0, 3)) {
            output.kv(`  - ${m.name}`, `${m.fileCount} files`);
          }
        }
      });
    }));
}