import { Command } from 'commander';
import { asyncHandler, output } from '@/cli/utils/shared.js';
import { writeFileSync, existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { writeClaudeSkill } from '@/cli/generators/agent-configs.js';

function addToGitignore(gitignorePath: string, entry: string): void {
  if (!existsSync(gitignorePath)) return;
  const content = readFileSync(gitignorePath, 'utf-8');
  if (content.split('\n').some((line) => line.trim() === entry)) return;
  appendFileSync(gitignorePath, `\n${entry}\n`);
}

interface AgentProfile {
  name: string;
  configPath: string;
  note: string;
  absolute?: boolean;
}

function claudeDesktopConfigPath(): string {
  if (platform() === 'win32')
    return join(
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json',
    );
  if (platform() === 'darwin')
    return join(
      homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

const AGENTS: Record<string, AgentProfile> = {
  'claude-code': {
    name: 'Claude Code',
    configPath: '.mcp.json',
    note: 'Picks up .mcp.json automatically on next session.',
  },
  'claude-desktop': {
    name: 'Claude Desktop',
    configPath: claudeDesktopConfigPath(),
    note: 'Global GUI-app config. PROJECTMIND_ROOT pinned to cwd.',
    absolute: true,
  },
  cursor: {
    name: 'Cursor',
    configPath: '.cursor/mcp.json',
    note: 'Reads .cursor/mcp.json from the workspace root.',
  },
  windsurf: {
    name: 'Windsurf',
    configPath: join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    note: 'Global config (~/.codeium/windsurf/mcp_config.json). PROJECTMIND_ROOT pinned.',
    absolute: true,
  },
  vscode: {
    name: 'VS Code Copilot / any stdio-MCP extension',
    configPath: '.vscode/mcp.json',
    note: 'VS Code MCP-compatible extensions read this.',
  },
};

const SERVER_ENTRY = {
  type: 'stdio' as const,
  command: 'projectmind',
  args: ['mcp'],
  env: { PROJECTMIND_ROOT: '.' },
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export function createInitMcpCommand(): Command {
  return new Command('init-mcp')
    .description('Generate MCP server config for a coding agent')
    .argument('<agent>', `Target agent: ${Object.keys(AGENTS).join('|')}`)
    .option('--force', 'Overwrite existing config file')
    .option('--claude-skills', 'Also generate .claude/skills/<name>/SKILL.md')
    .action(
      asyncHandler(async (agent: string, opts: { force?: boolean; claudeSkills?: boolean }) => {
        const profile = AGENTS[agent];
        if (!profile) {
          output.error(`Unknown agent "${agent}". Supported: ${Object.keys(AGENTS).join(', ')}`);
          throw new Error('MCP initialization failed');
        }

        const filePath = profile.absolute
          ? profile.configPath
          : join(process.cwd(), profile.configPath);
        if (!profile.absolute) {
          const configDir =
            profile.configPath.substring(0, profile.configPath.lastIndexOf('/')) || '.';
          if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
        } else {
          const absDir = filePath.substring(
            0,
            Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')),
          );
          if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });
        }

        if (existsSync(filePath) && !opts.force) {
          output.warn(`Config already exists at ${filePath}. Use --force to overwrite.`);
          return;
        }

        const entry = profile.absolute
          ? { ...SERVER_ENTRY, env: { PROJECTMIND_ROOT: process.cwd() } }
          : SERVER_ENTRY;
        let config: JsonObject = { mcpServers: { projectmind: entry } };

        if (existsSync(filePath)) {
          try {
            const existing = JSON.parse(readFileSync(filePath, 'utf-8')) as JsonObject;
            const prev = (existing['mcpServers'] as JsonObject) ?? {};
            existing['mcpServers'] = { ...prev, projectmind: entry };
            config = existing;
          } catch {
            /* overwrite */
          }
        }

        writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
        output.success(`✓ ${profile.name} MCP config written to ${filePath}`);
        output.kv('Note', profile.note);
        output.info('Make sure the CLI is installed: npm install -g @emirhanturker/projectmind');

        if (opts.claudeSkills) {
          const skill = writeClaudeSkill(process.cwd(), !!opts.force);
          if (!skill.written) {
            output.warn(`Skill already exists at ${skill.path}. Use --force to overwrite.`);
          } else {
            output.success(`✓ Claude Code skill written to ${skill.path}`);
          }
        }
      }),
    );
}
