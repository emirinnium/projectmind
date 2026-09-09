import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { reportSuppressedError } from '@/utils/errors.js';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type AgentKind = 'json-mcp' | 'opencode' | 'portable' | 'kilo' | 'codex';

const INSTRUCTIONS_START = '<!-- projectmind:mcp-instructions:start -->';
const INSTRUCTIONS_END = '<!-- projectmind:mcp-instructions:end -->';
const CODEX_START = '# projectmind:mcp-config:start';
const CODEX_END = '# projectmind:mcp-config:end';

export function packageVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : 'latest';
  } catch (error) {
    reportSuppressedError(error, 'Unable to read package version during MCP initialization');
    return 'latest';
  }
}

function serverEntry(root: string): JsonObject {
  const projectRoot = resolve(root);
  return {
    command: 'npx',
    args: ['--yes', `@emirhanturker/projectmind@${packageVersion(root)}`, 'mcp'],
    env: { PROJECTMIND_ROOT: projectRoot },
  };
}

/** Parse the small JSONC dialect used by OpenCode/Kilo project configs. */
function parseJsonc(content: string): JsonObject {
  let stripped = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const next = content[i + 1];
    if (inString) {
      stripped += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      stripped += char;
    } else if (char === '/' && next === '/') {
      while (i < content.length && content[i] !== '\n') i++;
      stripped += '\n';
    } else if (char === '/' && next === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) {
        if (content[i] === '\n') stripped += '\n';
        i++;
      }
      i++;
    } else {
      stripped += char;
    }
  }

  // Remove trailing commas with the same string-aware discipline. A regular
  // expression would corrupt legitimate values such as `"label,}"`.
  let withoutTrailingCommas = '';
  inString = false;
  escaped = false;
  for (let i = 0; i < stripped.length; i++) {
    const char = stripped[i];
    if (inString) {
      withoutTrailingCommas += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutTrailingCommas += char;
      continue;
    }
    if (char === ',') {
      let next = i + 1;
      while (/\s/.test(stripped[next] ?? '')) next++;
      if (stripped[next] === '}' || stripped[next] === ']') continue;
    }
    withoutTrailingCommas += char;
  }

  const parsed: unknown = JSON.parse(withoutTrailingCommas);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP config must contain a JSON object at the top level.');
  }
  return parsed as JsonObject;
}

function readJson(path: string): JsonObject {
  try {
    return parseJsonc(readFileSync(path, 'utf8'));
  } catch (error) {
    reportSuppressedError(error, `Unable to parse existing MCP config ${path}`);
    throw new Error(
      `Existing config is not valid JSON/JSONC: ${path}. Fix or back it up before running mcp-init.`,
    );
  }
}

function mergeConfig(config: JsonObject, root: string, kind: AgentKind): JsonObject {
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
    servers.projectmind = {
      type: 'local',
      command: ['npx', ...(entry.args as string[])],
      cwd: resolve(root),
      environment: { PROJECTMIND_ROOT: resolve(root) },
      disabled: false,
    };
    config.mcp = { ...mcp, servers };
  } else if (kind === 'kilo') {
    const mcp = (
      config.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp) ? config.mcp : {}
    ) as JsonObject;
    mcp.projectmind = {
      type: 'local',
      command: ['npx', ...(entry.args as string[])],
      environment: { PROJECTMIND_ROOT: resolve(root) },
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
  const projectRoot = JSON.stringify(resolve(root));
  return [
    CODEX_START,
    '# Generated by `pm mcp-init codex` — safe to replace between these markers.',
    '# If your Codex installation only reads ~/.codex/config.toml, merge this table there.',
    '',
    '[mcp_servers.projectmind]',
    'command = "npx"',
    `args = [${args}]`,
    `env = { PROJECTMIND_ROOT = ${projectRoot} }`,
    'enabled = true',
    '',
    CODEX_END,
  ].join('\n');
}

function instructions(agent: string): string {
  return [
    INSTRUCTIONS_START,
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
    INSTRUCTIONS_END,
  ].join('\n');
}

export function mergeProjectMindInstructions(
  current: string | undefined,
  agent: string,
  force: boolean,
): { content: string; changed: boolean } {
  const block = instructions(agent);
  if (current === undefined) return { content: `${block}\n`, changed: true };

  const start = current.indexOf(INSTRUCTIONS_START);
  const end = current.indexOf(INSTRUCTIONS_END);
  if (start >= 0 && end >= start) {
    const afterEnd = end + INSTRUCTIONS_END.length;
    const content = `${current.slice(0, start)}${block}${current.slice(afterEnd)}`;
    return { content, changed: force && content !== current };
  }

  // Older ProjectMind versions wrote an unmarked block. Preserve it and do
  // not append a second one; users can remove the legacy block deliberately.
  if (
    current.includes('# ProjectMind instructions') ||
    current.includes('ProjectMind Codebase Intelligence Rules')
  ) {
    return { content: current, changed: false };
  }

  return { content: `${current.trimEnd()}\n\n${block}\n`, changed: true };
}

export function writeInstructions(path: string, agent: string, force: boolean): boolean {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const merged = mergeProjectMindInstructions(current, agent, force);
  if (!merged.changed) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, merged.content, 'utf8');
  return true;
}

export function mergeCodexConfig(
  current: string | undefined,
  root: string,
  force: boolean,
): { content: string; changed: boolean } {
  const block = codexConfig(root);
  if (current === undefined) return { content: `${block}\n`, changed: true };

  const start = current.indexOf(CODEX_START);
  const end = current.indexOf(CODEX_END);
  if (start >= 0 && end >= start) {
    const afterEnd = end + CODEX_END.length;
    const content = `${current.slice(0, start)}${block}${current.slice(afterEnd)}`;
    return { content, changed: force && content !== current };
  }

  // Avoid duplicate TOML tables when an older generated block did not carry
  // markers. With --force, update the complete existing table in place.
  const table = /^\[mcp_servers\.projectmind\][^\r\n]*(?:\r?\n|$)/m.exec(current);
  if (table) {
    if (!force) return { content: current, changed: false };
    const remainderStart = table.index + table[0].length;
    const nextHeader = /^\[/m.exec(current.slice(remainderStart));
    const endIndex = nextHeader ? remainderStart + nextHeader.index : current.length;
    const content = `${current.slice(0, table.index)}${block}\n${current.slice(endIndex)}`;
    return { content, changed: content !== current };
  }

  return { content: `${current.trimEnd()}\n\n${block}\n`, changed: true };
}

/** Merge and write exactly the ProjectMind entry, preserving other clients. */
export function writeMcpConfig(
  path: string,
  root: string,
  kind: AgentKind,
  force: boolean,
): boolean {
  mkdirSync(dirname(path), { recursive: true });
  if (kind === 'codex') {
    const merged = mergeCodexConfig(
      existsSync(path) ? readFileSync(path, 'utf8') : undefined,
      root,
      force,
    );
    if (!merged.changed) return false;
    writeFileSync(path, merged.content, 'utf8');
    return true;
  }

  const existing = existsSync(path) ? readJson(path) : undefined;
  // mergeConfig updates nested MCP maps for clarity. Work on a deep JSON
  // copy so the semantic comparison still sees the original file state.
  const merged = mergeConfig(
    existing ? (JSON.parse(JSON.stringify(existing)) as JsonObject) : {},
    root,
    kind,
  );
  // Keep JSONC comments/formatting untouched when the semantic configuration
  // is already current. A real change is written as valid JSON.
  if (existing && JSON.stringify(existing) === JSON.stringify(merged)) return false;
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return true;
}
