import { Command } from 'commander';
import { asyncHandler, output, loadConfig } from '@/cli/utils/shared.js';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { writeClaudeSkill } from '@/cli/generators/agent-configs.js';
import {
  packageVersion,
  writeInstructions,
  writeMcpConfig,
  type AgentKind,
} from './init-mcp-config.js';

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

/**
 * Use an existing JSONC/JSON variant when an agent supports both names.
 * This prevents mcp-init from creating a second config that the client never
 * reads, while keeping the documented default for new projects.
 */
export function resolveAgentConfigPath(
  root: string,
  agent: string,
  configPath: string,
  absolute = false,
): string {
  if (absolute) return configPath;
  const configured = join(root, configPath);
  if (existsSync(configured)) return configured;

  const alternatives: Record<string, string> = {
    opencode: 'opencode.jsonc',
    'kilo-code': join('.kilo', 'kilo.json'),
  };
  const alternative = alternatives[agent.toLowerCase()];
  if (!alternative) return configured;
  const existingAlternative = join(root, alternative);
  return existsSync(existingAlternative) ? existingAlternative : configured;
}

const AGENTS: Record<string, AgentProfile> = {
  'claude-code': {
    name: 'Claude Code',
    configPath: '.mcp.json',
    kind: 'json-mcp',
    instructionPath: 'CLAUDE.md',
    note: 'Project .mcp.json is loaded by the next Claude Code session.',
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
  'kilo-code': {
    name: 'Kilo Code',
    configPath: '.kilo/kilo.jsonc',
    kind: 'kilo',
    instructionPath: 'AGENTS.md',
    note: 'Project-local Kilo Code MCP config and instructions generated.',
  },
};

export function createInitMcpCommand(): Command {
  return new Command('init-mcp')
    .alias('mcp-init')
    .description('Generate a production-ready ProjectMind MCP config and agent instructions')
    .argument('<agent>', `Target agent: ${Object.keys(AGENTS).join('|')}`)
    .option('--force', 'Update the generated ProjectMind section; unrelated settings are preserved')
    .option('--claude-skills', 'Also generate .claude/skills/<name>/SKILL.md')
    .action(
      asyncHandler(async (agent: string, opts: { force?: boolean; claudeSkills?: boolean }) => {
        const profile = AGENTS[agent.toLowerCase()];
        if (!profile) {
          output.error(`Unknown agent "${agent}". Supported: ${Object.keys(AGENTS).join(', ')}`);
          throw new Error('MCP initialization failed');
        }
        const root = loadConfig().projectRoot;
        const filePath = resolveAgentConfigPath(root, agent, profile.configPath, profile.absolute);
        const configChanged = writeMcpConfig(filePath, root, profile.kind, !!opts.force);
        if (configChanged) output.success(`${profile.name} MCP config written to ${filePath}`);
        else output.info(`ProjectMind MCP config already current at ${filePath}`);

        const instructionPath = join(root, profile.instructionPath);
        if (writeInstructions(instructionPath, agent, !!opts.force))
          output.success(`Agent instructions written to ${instructionPath}`);
        else output.info(`Agent instructions already present in ${instructionPath}`);

        if (opts.claudeSkills || agent.toLowerCase() === 'claude-code') {
          const skill = writeClaudeSkill(root, !!opts.force);
          if (skill.written) output.success(`Claude Code skill written to ${skill.path}`);
        }
        output.kv('Note', profile.note);
        output.info(
          `MCP server uses @emirhanturker/projectmind@${packageVersion(root)} via npx and PROJECTMIND_ROOT=.`,
        );
      }),
    );
}
