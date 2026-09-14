import { Command } from 'commander';
import { withContext, asyncHandler, output } from '@/cli/utils/shared.js';
import { join } from '@/cli/utils/shared.js';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PMIGNORE_CONTENT } from '@/utils/ignore.js';

function addToGitignore(gitignorePath: string, entry: string): void {
  if (!existsSync(gitignorePath)) return;
  const content = readFileSync(gitignorePath, 'utf-8');
  if (content.split('\n').some((line) => line.trim() === entry)) return;
  appendFileSync(gitignorePath, `\n${entry}\n`);
}

/** Create only missing, safe project bootstrap files; never overwrite user data. */
export function initializeProjectFiles(projectRoot: string): string[] {
  const root = resolve(projectRoot);
  const created: string[] = [];
  const configDir = join(root, '.projectmind');
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

  const mcpPath = join(root, '.mcp.json');
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
    created.push('.mcp.json');
  }

  const configFile = join(root, '.projectmindrc.json');
  if (!existsSync(configFile)) {
    // Keep this sparse: global config supplies defaults and this file is the
    // project-owned override layer. Secrets are intentionally not scaffolded.
    writeFileSync(
      configFile,
      JSON.stringify({ description: 'ProjectMind config' }, null, 2) + '\n',
    );
    created.push('.projectmindrc.json');
  }

  const pmignoreFile = join(root, '.pmignore');
  if (!existsSync(pmignoreFile)) {
    writeFileSync(pmignoreFile, DEFAULT_PMIGNORE_CONTENT);
    created.push('.pmignore');
  }

  addToGitignore(join(root, '.gitignore'), '.projectmindrc.json');
  addToGitignore(join(root, '.gitignore'), '.projectmind/');
  return created;
}

export function createInitCommand(): Command {
  return new Command('init')
    .description('Initialize ProjectMind on this project')
    .option('-r, --root <path>', 'Project directory; defaults to the current directory')
    .action(
      asyncHandler(async (options: { root?: string }) => {
        // Init is a bootstrap command: absent --root always means the current
        // directory, even when a global config points at another project.
        const projectRoot = options.root ? resolve(options.root) : process.cwd();
        await withContext(async (ctx) => {
          const config = ctx.config;
          output.info(`Initializing ProjectMind in: ${projectRoot}`);
          output.kv('Database path', config.databasePath);

          await ctx.kg.getAllFiles(); // Force DB init

          // .mcp.json is the Claude Code/Cursor-compatible project config. Other
          // agents have dedicated layouts exposed by `pm mcp-init <agent>`.
          for (const file of initializeProjectFiles(projectRoot)) {
            output.success(`${file} created`);
          }

          output.success('ProjectMind initialized successfully.');
          output.info('Run "projectmind scan" to build the knowledge graph.');
          output.info('All MCP-aware agents auto-connect via .mcp.json.');
        }, projectRoot);
      }),
    );
}
