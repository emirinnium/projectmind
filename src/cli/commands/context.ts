import { Command } from 'commander';
import { BaseCommand, asyncHandler, output } from '@/cli/utils/shared.js';

class ContextCommand extends BaseCommand {
  constructor() {
    super('context', 'Get relevant context for a file');
  }

  registerCommands(): Command {
    const cmd = this.cmd;

    cmd
      .argument('<file>', 'File path')
      .action(asyncHandler(async (filePath: string) => {
        await this.withService(['scale'], async (_ctx, services) => {
          const scale = services.scale!;
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

    return cmd;
  }
}

export function createContextCommand(): Command {
  return new ContextCommand().registerCommands();
}