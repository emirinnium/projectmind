import { Command } from 'commander';
import { asyncHandler, output } from '@/cli/utils/shared.js';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import {
  buildOpencodeConfig,
  writeClaudeSkill,
  writeOpencodeConfig,
} from '@/cli/generators/agent-configs.js';

interface AgentProfile {
  name: string;
  configPath: string; // relative to project root (or absolute when absolute=true)
  format: 'mcpServers' | 'opencode-mcp' | 'vscode-mcp';
  note: string;
  /** Config lives outside the project — PROJECTMIND_ROOT gets an absolute path. */
  absolute?: boolean;
}

/** Claude Desktop config location per OS (GUI app — never reads .mcp.json). */
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
    format: 'mcpServers',
    note: 'Project-scope. Claude Code picks this up automatically on next session. Pair with --claude-skills for a project SKILL.md.',
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
    configPath: 'opencode.json',
    format: 'opencode-mcp',
    note: 'OpenCode reads opencode.json from the project root. Spec-compliant local entry: $schema, environment, enabled:true, tools scoping.',
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

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export function createInitMcpCommand(): Command {
  return new Command('init-mcp')
    .description('Generate MCP server config for a coding agent')
    .argument('<agent>', `Target agent: ${Object.keys(AGENTS).join('|')}`)
    .option('--force', 'Overwrite existing config file')
    .option(
      '--claude-skills',
      'Also generate .claude/skills/<name>/SKILL.md introducing ProjectMind tools (Claude Code skills format)',
    )
    .option(
      '--opencode-config',
      'Also generate a spec-compliant opencode.json (OpenCode local MCP entry + toolset scoping)',
    )
    .action(
      asyncHandler(
        async (
          agent: string,
          opts: { force?: boolean; claudeSkills?: boolean; opencodeConfig?: boolean },
        ) => {
          const profile = AGENTS[agent];
          if (!profile) {
            output.error(`Unknown agent "${agent}". Supported: ${Object.keys(AGENTS).join(', ')}`);
            process.exit(1);
          }

          const filePath = profile.absolute
            ? profile.configPath // already absolute (expanded)
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

          // Absolute profiles pin the workspace root explicitly.
          const entry = profile.absolute
            ? { ...SERVER_ENTRY_MCP_SERVERS, env: { PROJECTMIND_ROOT: process.cwd() } }
            : SERVER_ENTRY_MCP_SERVERS;

          let config: JsonObject;
          if (profile.format === 'opencode-mcp') {
            // OpenCode spec: opencode.json with $schema / environment / enabled /
            // tools scoping — NOT the legacy mcpServers shape.
            config = buildOpencodeConfig();
          } else {
            config = { mcpServers: { projectmind: entry } };
          }

          // Merge into existing JSON if present
          if (existsSync(filePath)) {
            try {
              const existing = JSON.parse(readFileSync(filePath, 'utf-8')) as JsonObject;
              const mergeKey = profile.format === 'opencode-mcp' ? 'mcp' : 'mcpServers';
              const newEntry = config[mergeKey] as JsonObject | undefined;
              if (newEntry && typeof existing === 'object') {
                const prev = (existing[mergeKey] as JsonObject) ?? {};
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

          // --- Faz 3: optional native client artifacts ---------------------

          if (opts.claudeSkills) {
            const skill = writeClaudeSkill(process.cwd(), !!opts.force);
            if (!skill.written) {
              output.warn(`Skill already exists at ${skill.path}. Use --force to overwrite.`);
            } else {
              output.success(`✓ Claude Code skill written to ${skill.path}`);
              output.info(
                'Claude Code discovers .claude/skills on session start (restart the session to load it).',
              );
            }
          }

          if (opts.opencodeConfig) {
            // When the target is opencode itself the config was just written
            // above; the flag is still honored for every other agent.
            if (profile.format !== 'opencode-mcp') {
              const oc = writeOpencodeConfig(process.cwd(), !!opts.force);
              if (!oc.written) {
                output.warn(
                  `opencode.json already exists at ${oc.path}. Use --force to overwrite.`,
                );
              } else {
                output.success(`✓ OpenCode config written to ${oc.path}`);
              }
            } else {
              output.info(`opencode.json was already generated for the opencode agent above.`);
            }
          }
        },
      ),
    );
}
