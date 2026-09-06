import { Command } from 'commander';
import { asyncHandler, output } from '@/cli/utils/shared.js';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { writeClaudeSkill } from '@/cli/generators/agent-configs.js';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type AgentKind = 'json-mcp' | 'opencode' | 'portable' | 'kilo' | 'codex';

interface AgentProfile {
  name: string;
  configPath: string;
  kind: AgentKind;
  note: string;
  instructionPath: string;
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
    kind: 'json-mcp',
    instructionPath: 'CLAUDE.md',
    note: 'Project .mcp.json is loaded by the next Claude Code session.',
  },
  claude: {
    name: 'Claude Code',
    configPath: '.mcp.json',
    kind: 'json-mcp',
    instructionPath: 'CLAUDE.md',
    note: 'Alias for claude-code.',
  },
  'claude-desktop': {
    name: 'Claude Desktop',
    configPath: claudeDesktopConfigPath(),
    kind: 'json-mcp',
    instructionPath: 'CLAUDE.md',
    absolute: true,
    note: 'Global desktop config; PROJECTMIND_ROOT is pinned to this project.',
  },
  codex: {
    name: 'Codex',
    configPath: '.codex/config.toml',
    kind: 'codex',
    instructionPath: 'AGENTS.md',
    note: 'Project-local Codex MCP block and instructions generated.',
  },
  opencode: {
    name: 'OpenCode',
    configPath: 'opencode.json',
    kind: 'opencode',
    instructionPath: 'AGENTS.md',
    note: 'OpenCode v2 mcp.servers configuration generated.',
  },
  cursor: {
    name: 'Cursor',
    configPath: '.cursor/mcp.json',
    kind: 'json-mcp',
    instructionPath: 'AGENTS.md',
    note: 'Workspace Cursor MCP config generated.',
  },
  windsurf: {
    name: 'Windsurf',
    configPath: join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    kind: 'json-mcp',
    instructionPath: 'AGENTS.md',
    absolute: true,
    note: 'Global Windsurf config generated; refresh the MCP panel.',
  },
  vscode: {
    name: 'VS Code MCP',
    configPath: '.vscode/mcp.json',
    kind: 'json-mcp',
    instructionPath: 'AGENTS.md',
    note: 'Workspace VS Code MCP config generated.',
  },
  devin: {
    name: 'Devin',
    configPath: '.devin/mcp.json',
    kind: 'portable',
    instructionPath: 'DEVIN.md',
    note: 'Portable manifest; import it in Devin MCP settings if auto-discovery is unavailable.',
  },
  antigravity: {
    name: 'Google Antigravity',
    configPath: '.agent/mcp_config.json',
    kind: 'json-mcp',
    instructionPath: '.agent/rules/projectmind.md',
    note: 'Project-local Antigravity MCP config and rule generated.',
  },
  kilo: {
    name: 'Kilo Code',
    configPath: '.kilo/kilo.jsonc',
    kind: 'kilo',
    instructionPath: 'AGENTS.md',
    note: 'Project-local Kilo config generated under .kilo/kilo.jsonc.',
  },
  'kilo-code': {
    name: 'Kilo Code',
    configPath: '.kilo/kilo.jsonc',
    kind: 'kilo',
    instructionPath: 'AGENTS.md',
    note: 'Alias for kilo.',
  },
};

function packageVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : 'latest';
  } catch {
    return 'latest';
  }
}

function serverEntry(root: string): JsonObject {
  return {
    command: 'npx',
    args: ['--yes', `@emirhanturker/projectmind@${packageVersion(root)}`, 'mcp'],
    env: { PROJECTMIND_ROOT: '.' },
  };
}

function readJson(path: string, force: boolean): JsonObject {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
  } catch {
    if (force) return {};
    throw new Error(`Existing config is not valid JSON: ${path}. Use --force after backing it up.`);
  }
}

function mergeConfig(path: string, root: string, kind: AgentKind, force: boolean): JsonObject {
  const config = readJson(path, force);
  const entry = serverEntry(root);
  if (kind === 'opencode') {
    const mcp = (
      config.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp) ? config.mcp : {}
    ) as JsonObject;
    const servers = (
      mcp.servers && typeof mcp.servers === 'object' && !Array.isArray(mcp.servers)
        ? mcp.servers
        : {}
    ) as JsonObject;
    servers.projectmind = { type: 'local', command: ['npx', ...(entry.args as string[])] };
    config.mcp = { ...mcp, servers };
  } else if (kind === 'kilo') {
    const mcp = (
      config.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp) ? config.mcp : {}
    ) as JsonObject;
    mcp.projectmind = {
      type: 'local',
      command: ['npx', ...(entry.args as string[])],
      enabled: true,
    };
    config.mcp = mcp;
  } else {
    const servers = (
      config.mcpServers &&
      typeof config.mcpServers === 'object' &&
      !Array.isArray(config.mcpServers)
        ? config.mcpServers
        : {}
    ) as JsonObject;
    config.mcpServers = { ...servers, projectmind: entry };
  }
  return config;
}

function codexConfig(root: string): string {
  const args = (serverEntry(root).args as string[]).map((arg) => JSON.stringify(arg)).join(', ');
  return [
    '# Generated by `pm mcp-init codex`',
    '# If your Codex installation only reads ~/.codex/config.toml, merge this table there.',
    '',
    '[mcp_servers.projectmind]',
    'command = "npx"',
    `args = [${args}]`,
    'enabled = true',
    '',
  ].join('\n');
}

function instructions(agent: string): string {
  return [
    `# ProjectMind instructions (${agent})`,
    '',
    'ProjectMind is this repository’s codebase knowledge graph and MCP intelligence layer.',
    '',
    'Before editing: call `get_context` and `analyze_impact` for the target file.',
    'After editing: call `check_coherence` and resolve warnings before continuing.',
    'Before committing: call `debt_report`, `find_circular_deps`, and `genome_score`.',
    'Keep PROJECTMIND_ROOT pinned to this repository and never expose secrets in tool output.',
    'Use `scan_project` after adding files and `store_memory` for durable architectural decisions.',
    '',
  ].join('\n');
}

function writeInstructions(path: string, agent: string, force: boolean): boolean {
  const body = instructions(agent);
  if (existsSync(path) && !force) {
    const current = readFileSync(path, 'utf8');
    if (current.includes('# ProjectMind instructions')) return false;
    writeFileSync(path, `${current.trimEnd()}\n\n${body}`, 'utf8');
    return true;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
  return true;
}

export function createInitMcpCommand(): Command {
  return new Command('init-mcp')
    .alias('mcp-init')
    .description('Generate a production-ready ProjectMind MCP config and agent instructions')
    .argument('<agent>', `Target agent: ${Object.keys(AGENTS).join('|')}`)
    .option('--force', 'Replace the generated ProjectMind config section/file')
    .option('--claude-skills', 'Also generate .claude/skills/<name>/SKILL.md')
    .action(
      asyncHandler(async (agent: string, opts: { force?: boolean; claudeSkills?: boolean }) => {
        const profile = AGENTS[agent.toLowerCase()];
        if (!profile) {
          output.error(`Unknown agent "${agent}". Supported: ${Object.keys(AGENTS).join(', ')}`);
          throw new Error('MCP initialization failed');
        }
        const root = process.cwd();
        const filePath = profile.absolute ? profile.configPath : join(root, profile.configPath);
        if (existsSync(filePath) && !opts.force)
          output.warn(`Config already exists at ${filePath}. Use --force to update it.`);
        else {
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(
            filePath,
            profile.kind === 'codex'
              ? codexConfig(root)
              : `${JSON.stringify(mergeConfig(filePath, root, profile.kind, !!opts.force), null, 2)}\n`,
            'utf8',
          );
          output.success(`✓ ${profile.name} MCP config written to ${filePath}`);
        }
        const instructionPath = join(root, profile.instructionPath);
        if (writeInstructions(instructionPath, agent, !!opts.force))
          output.success(`✓ Agent instructions written to ${instructionPath}`);
        else output.info(`Agent instructions already present in ${instructionPath}`);
        if (opts.claudeSkills || agent === 'claude' || agent === 'claude-code') {
          const skill = writeClaudeSkill(root, !!opts.force);
          if (skill.written) output.success(`✓ Claude Code skill written to ${skill.path}`);
        }
        output.kv('Note', profile.note);
        output.info(
          `MCP server uses @emirhanturker/projectmind@${packageVersion(root)} via npx and PROJECTMIND_ROOT=.`,
        );
      }),
    );
}
