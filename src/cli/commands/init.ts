import { Command } from 'commander';
import { withContext, asyncHandler, output } from '@/cli/utils/shared.js';
import { join } from '@/cli/utils/shared.js';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

function addToGitignore(gitignorePath: string, entry: string): void {
  if (!existsSync(gitignorePath)) return;
  const content = readFileSync(gitignorePath, 'utf-8');
  if (content.split('\n').some((line) => line.trim() === entry)) return;
  appendFileSync(gitignorePath, `\n${entry}\n`);
}

export function createInitCommand(): Command {
  return new Command('init').description('Initialize ProjectMind on this project').action(
    asyncHandler(async () => {
      await withContext(async (ctx) => {
        const config = ctx.config;
        output.info(`Initializing ProjectMind in: ${process.cwd()}`);
        output.kv('Database path', config.databasePath);

        await ctx.kg.getAllFiles(); // Force DB init

        const configDir = join(process.cwd(), '.projectmind');
        if (!existsSync(configDir)) {
          mkdirSync(configDir, { recursive: true });
        }

        // .mcp.json at project root is the universal MCP config file.
        // All MCP-aware agents (Claude Code, Cursor, Codex, etc.) read it automatically.
        const mcpPath = join(process.cwd(), '.mcp.json');
        if (!existsSync(mcpPath)) {
          const mcpConfig = {
            mcpServers: {
              projectmind: {
                type: 'stdio',
                command: 'projectmind',
                args: ['mcp'],
                env: { PROJECTMIND_ROOT: '.' },
                description: 'ProjectMind - Living Codebase Intelligence Layer for AI Agents',
              },
            },
          };
          writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n');
          output.success('✓ .mcp.json written (universal MCP config — read by all agents)');
        }

        // loadConfig() reads .projectmindrc.json from the project ROOT,
        const configFile = join(process.cwd(), '.projectmindrc.json');
        if (!existsSync(configFile)) {
          writeFileSync(configFile, JSON.stringify({ description: 'ProjectMind config' }, null, 2));
          output.kv('Config created', '.projectmindrc.json');
        }

        // .gitignore entries for project-specific configs
        const gitignorePath = join(process.cwd(), '.gitignore');
        addToGitignore(gitignorePath, '.projectmindrc.json');
        addToGitignore(gitignorePath, '.projectmind/');

        output.success('ProjectMind initialized successfully.');
        output.info('Run "projectmind scan" to build the knowledge graph.');
        output.info('All MCP-aware agents auto-connect via .mcp.json.');
      });
    }),
  );
}
