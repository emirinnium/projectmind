import { Command } from 'commander';
import { asyncHandler, output } from '@/cli/utils/shared.js';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

interface AgentProfile {
  name: string;
  configPath: string;       // relative to project root (or absolute)
  format: 'mcpServers' | 'opencode-mcp' | 'vscode-mcp';
  note: string;
}

const AGENTS: Record<string, AgentProfile> = {
  'claude-code': {
    name: 'Claude Code',
    configPath: '.mcp.json',
    format: 'mcpServers',
    note: 'Project-scope. Claude Code picks this up automatically on next session.',
  },
  cursor: {
    name: 'Cursor',
    configPath: '.cursor/mcp.json',
    format: 'mcpServers',
    note: 'Cursor reads this from the workspace root.',
  },
  opencode: {
    name: 'OpenCode',
    configPath: '.opencode/mcp.json',
    format: 'opencode-mcp',
    note: 'OpenCode local MCP configuration.',
  },
  windsurf: {
    name: 'Windsurf',
    configPath: '.windsurf/mcp.json',
    format: 'mcpServers',
    note: 'Windsurf local MCP configuration.',
  },
  vscode: {
    name: 'VS Code Copilot / any stdio-MCP extension',
    configPath: '.vscode/mcp.json',
    format: 'mcpServers',
    note: 'VS Code MCP-compatible extensions read this.',
  },
};

const SERVER_ENTRY_MCP_SERVERS = {
  command: 'npx',
  args: ['-y', '@emirhanturker/projectmind@latest', 'mcp'],
  env: { PROJECTMIND_ROOT: '.' },
};

const SERVER_ENTRY_OPENCODE = {
  type: 'local',
  command: ['npx', '-y', '@emirhanturker/projectmind@latest', 'mcp'],
  environment: { PROJECTMIND_ROOT: '.' },
};

export function createInitMcpCommand(): Command {
  return new Command('init-mcp')
    .description('Generate MCP server config for a coding agent')
    .argument('<agent>', `Target agent: ${Object.keys(AGENTS).join('|')}`)
    .option('--force', 'Overwrite existing config file')
    .action(
      asyncHandler(async (agent: string, opts: { force?: boolean }) => {
        const profile = AGENTS[agent];
        if (!profile) {
          output.error(`Unknown agent "${agent}". Supported: ${Object.keys(AGENTS).join(', ')}`);
          process.exit(1);
        }

        const configDir = agent === 'claude-code'
          ? '.'
          : profile.configPath.substring(0, profile.configPath.lastIndexOf('/')) || '.';

        if (!existsSync(configDir)) {
          mkdirSync(configDir, { recursive: true });
        }

        const filePath = profile.configPath.startsWith('.')
          ? join(process.cwd(), profile.configPath)
          : profile.configPath;

        if (existsSync(filePath) && !opts.force) {
          output.warn(`Config already exists at ${filePath}. Use --force to overwrite.`);
          return;
        }

        let config: Record<string, unknown>;
        if (profile.format === 'opencode-mcp') {
          config = { mcp: { projectmind: SERVER_ENTRY_OPENCODE } };
        } else {
          config = { mcpServers: { projectmind: SERVER_ENTRY_MCP_SERVERS } };
        }

        // Merge into existing JSON if present
        if (existsSync(filePath)) {
          try {
            const existing = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
            const mergeKey = profile.format === 'opencode-mcp' ? 'mcp' : 'mcpServers';
            const newEntry = config[mergeKey] as Record<string, unknown> | undefined;
            if (newEntry && typeof existing === 'object') {
              const prev = (existing[mergeKey] as Record<string, unknown>) ?? {};
              existing[mergeKey] = { ...prev, ...newEntry };
              config = existing;
            }
          } catch {
            // Existing file is corrupt — overwrite with fresh config
          }
        }

        writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
        output.success(`✓ ${profile.name} MCP config written to ${filePath}`);
        output.kv('Note', profile.note);
        output.info(`Make sure the CLI is installed: npm install -g @emirhanturker/projectmind`);
      })
    );
}
