import { Command } from 'commander';
import { asyncHandler, output, loadConfig } from '@/cli/utils/shared.js';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { writeClaudeSkill } from '@/cli/generators/agent-configs.js';
import {
  packageVersion,
  writeInstructions,
  writeMcpConfig,
  verifyMcpConfig,
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

interface HandshakeResult {
  ok: boolean;
  durationMs: number;
  response?: {
    serverInfo?: { name?: string; version?: string };
    capabilities?: Record<string, unknown>;
  };
  toolCount?: number;
  stderr?: string;
  error?: string;
}

type HandshakeUpdate = Omit<HandshakeResult, 'durationMs'>;

async function runMcpHandshake(root: string): Promise<HandshakeResult> {
  const started = Date.now();
  const version = packageVersion(root);
  if (!/^(?:latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.test(version)) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: 'The local ProjectMind package version is not safe for an MCP handshake command.',
    };
  }
  const packageVersionArg = `@emirhanturker/projectmind@${version}`;
  const windows = platform() === 'win32';
  const executable = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npx';
  const spawnArgs = windows
    ? ['/d', '/s', '/c', `npx -y ${packageVersionArg} mcp --profile core`]
    : ['--yes', packageVersionArg, 'mcp', '--profile', 'core'];
  const child = spawn(executable, spawnArgs, {
    cwd: root,
    env: { ...process.env, PROJECTMIND_ROOT: root, PROJECTMIND_TOOLS: 'core' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  let toolsListRequested = false;
  return await new Promise<HandshakeResult>((resolve) => {
    const finish = (result: HandshakeUpdate): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve({ ...result, durationMs: Date.now() - started, stderr: stderr.slice(-2000) });
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: 'MCP handshake timed out after 15000 ms.' }),
      15000,
    );
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      let newline = stdout.indexOf('\n');
      while (newline >= 0) {
        const line = stdout.slice(0, newline).replace(/\r$/, '');
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf('\n');
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as {
            id?: number;
            result?: HandshakeResult['response'] & { tools?: unknown[] };
          };
          if (message.id === 1 && message.result && !toolsListRequested) {
            toolsListRequested = true;
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
            );
          } else if (message.id === 2 && message.result) {
            const tools = Array.isArray(message.result.tools) ? message.result.tools : [];
            finish({
              ok: true,
              response: {
                serverInfo: message.result.serverInfo,
                capabilities: message.result.capabilities,
              },
              toolCount: tools.length,
            });
          }
        } catch (error) {
          // MCP logs belong on stderr; ignore non-JSON stdout until a response frame arrives.
          void error;
          continue;
        }
      }
      stdout = stdout.slice(-16_000);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => finish({ ok: false, error: error.message }));
    child.on('close', (code) => {
      if (!settled)
        finish({
          ok: false,
          error: `MCP process exited before initialize response (code ${code ?? 'unknown'}).`,
        });
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'projectmind-mcp-verify', version: '1.0.0' } } })}\n`,
    );
  });
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
    .option('--verify', 'Read-only verify the existing MCP config and ProjectMind entry')
    .option('--handshake', 'With --verify, launch a bounded MCP handshake check')
    .option('--claude-skills', 'Also generate .claude/skills/<name>/SKILL.md')
    .action(
      asyncHandler(
        async (
          agent: string,
          opts: { force?: boolean; claudeSkills?: boolean; verify?: boolean; handshake?: boolean },
        ) => {
          const profile = AGENTS[agent.toLowerCase()];
          if (!profile) {
            output.error(`Unknown agent "${agent}". Supported: ${Object.keys(AGENTS).join(', ')}`);
            throw new Error('MCP initialization failed');
          }
          const root = loadConfig().projectRoot;
          if (opts.handshake && !opts.verify) {
            throw new Error('--handshake requires --verify because it is read-only verification.');
          }
          const filePath = resolveAgentConfigPath(
            root,
            agent,
            profile.configPath,
            profile.absolute,
          );
          if (opts.verify) {
            const verification = verifyMcpConfig(filePath, root, profile.kind);
            output.section(`MCP verification — ${profile.name}`);
            output.kv('Config', verification.path);
            output.kv('ProjectMind entry', verification.projectmindEntry ? 'present' : 'missing');
            for (const check of verification.checks)
              output.kv(
                `${check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗'} ${check.name}`,
                check.detail,
              );
            if (opts.handshake) {
              const handshake = await runMcpHandshake(root);
              output.kv('Handshake', handshake.ok ? `pass (${handshake.durationMs} ms)` : 'fail');
              if (handshake.response?.serverInfo)
                output.kv(
                  'Server',
                  `${handshake.response.serverInfo.name ?? 'unknown'} ${handshake.response.serverInfo.version ?? ''}`.trim(),
                );
              if (handshake.ok) output.kv('Tools/list', String(handshake.toolCount ?? 0));
              if (!handshake.ok)
                output.warn(
                  `${handshake.error ?? 'MCP handshake failed'} ${handshake.stderr ?? ''}`.trim(),
                );
              if (!handshake.ok)
                throw new Error(
                  'MCP handshake failed. Check the reported process output and retry.',
                );
            }
            if (!verification.ok) throw new Error(verification.nextActions.join(' '));
            return;
          }
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
        },
      ),
    );
}
