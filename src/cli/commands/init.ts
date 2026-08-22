import { Command } from 'commander';
import { withContext, asyncHandler, output } from '@/cli/utils/shared.js';
import { join } from '@/cli/utils/shared.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

export function createInitCommand(): Command {
  return new Command('init')
    .description('Initialize ProjectMind on this project')
    .action(asyncHandler(async () => {
      await withContext(async (ctx) => {
        const config = ctx.config;
        output.info(`Initializing ProjectMind in: ${process.cwd()}`);
        output.kv('Database path', config.databasePath);

        await ctx.kg.getAllFiles(); // Force DB init

        const configDir = join(process.cwd(), '.projectmind');
        if (!existsSync(configDir)) {
          mkdirSync(configDir, { recursive: true });
        }

        // loadConfig() reads .projectmindrc.json from the project ROOT,
        // so the starter config must be written there (not inside .projectmind/).
        const configFile = join(process.cwd(), '.projectmindrc.json');
        if (!existsSync(configFile)) {
          writeFileSync(configFile, JSON.stringify({ description: 'ProjectMind config' }, null, 2));
          output.kv('Config created', '.projectmindrc.json');
        }

        output.success('ProjectMind initialized successfully.');
        output.info('Run "projectmind scan" to build the knowledge graph.');
      });
    }));
}