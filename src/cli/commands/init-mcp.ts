import { Command } from 'commander';
import { asyncHandler, output } from '@/cli/utils/shared.js';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

interface AgentProfile {
  name: string;
  configPath: string;       // relative to project root (or absolute when absolute=true)
  format: 'mcpServers' | 'opencode-mcp' | 'vscode-mcp';
  note: string;
  /** Config lives outside the project — PROJECTMIND_ROOT gets an absolute path. */
  absolute?: boolean;
}

/** Claude Desktop config location per OS (GUI app — never reads .mcp.json). */
function claudeDesktopConfigPath(): string {
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

const AGENTS: Record<string, AgentProfile> = {
  'claude-code': {
    name: 'Claude Code',
    configPath: '.mcp.json',
    format: 'mcpServers',
    note: 'Project-scope. Claude Code picks this up automatically on next session.',
  },
  'claude-desktop': {
    name: 'Claude Desktop',
    configPath: claudeDesktopConfigPath(),
    format: 'mcpServers',
    note: 'Global GUI-app config. PROJECTMIND_ROOT is pinned to the directory where you ran this command.',
    absolute: true,
  },
  cursor: {
    name: 'Cursor',
    configPath: '.cursor/mcp.json',
    format: 'mcpServers',
    note: 'Cursor reads this from the workspace root. Tip: set PROJECTMIND_TOOLS=core in env to stay under the active-tool limit.',
  },
  opencode: {
    name: 'OpenCode',
    configPath: '.opencode/mcp.json',
    format: 'opencode-mcp',
    note: 'OpenCode local MCP configuration.',
  },
  windsurf: {
    name: 'Windsurf',
    configPath: join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    format: 'mcpServers',
    note: 'OFFICIAL global config (~/.codeium/windsurf/mcp_config.json). Click Refresh in the Windsurf MCP panel after writing. PROJECTMIND_ROOT pinned to where you ran this command.',
    absolute: true,
  },
  vscode: {
    name: 'VS Code Copilot / any stdio-MCP extension',
    configPath: '.vscode/mcp.json',
    format: 'mcpServers',
    note: 'VS Code MCP-compatible extensions read this.',
  },
};

const SERVER_ENTRY_MCP_SERVERS = {
  type: 'stdio',
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

        const filePath = profile.absolute
          ? profile.configPath // already absolute (expanded)
          : join(process.cwd(), profile.configPath);
        if (!profile.absolute) {
          const configDir = profile.configPath.substring(0, profile.configPath.lastIndexOf('/')) || '.';
          if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
        } else {
          const absDir = filePath.substring(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')));
          if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });
        }

        if (existsSync(filePath) && !opts.force) {
          output.warn(`Config already exists at ${filePath}. Use --force to overwrite.`);
          return;
        }

        // Absolute profiles pin the workspace root explicitly.
        const entry = profile.absolute
          ? { ...SERVER_ENTRY_MCP_SERVERS, env: { PROJECTMIND_ROOT: process.cwd() } }
          : SERVER_ENTRY_MCP_SERVERS;
        const entryOpen = profile.absolute
          ? { ...SERVER_ENTRY_OPENCODE, environment: { PROJECTMIND_ROOT: process.cwd() } }
          : SERVER_ENTRY_OPENCODE;

        let config: Record<string, unknown>;
        if (profile.format === 'opencode-mcp') {
          config = { mcp: { projectmind: entryOpen } };
        } else {
          config = { mcpServers: { projectmind: entry } };
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
