import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { reportSuppressedError } from '@/utils/errors.js';
import { writeFileAtomically } from '@/utils/atomic-write.js';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type AgentKind = 'json-mcp' | 'opencode' | 'portable' | 'kilo' | 'codex';

export interface McpConfigVerification {
  ok: boolean;
  path: string;
  format: AgentKind;
  projectmindEntry: boolean;
  duplicateProjectMindEntries: number;
  checks: Array<{ name: string; status: 'pass' | 'warn' | 'fail'; detail: string }>;
  nextActions: string[];
}

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

function normalizedPathForComparison(value: string): string {
  const normalized = resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function isPinnedProjectRootValue(value: string, root: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('${')) return false;
  try {
    // A project-local `.` is an intentional pin to the config's active root;
    // absolute and relative paths are compared after platform normalization.
    return (
      normalizedPathForComparison(resolve(root, trimmed)) === normalizedPathForComparison(root)
    );
  } catch {
    return false;
  }
}

function hasPinnedProjectRoot(entry: JsonObject, root: string): boolean {
  const candidates: string[] = [];
  if (typeof entry.cwd === 'string') candidates.push(entry.cwd);
  for (const environmentKey of ['env', 'environment']) {
    const environment = entry[environmentKey];
    if (environment && typeof environment === 'object' && !Array.isArray(environment)) {
      const projectRoot = (environment as JsonObject).PROJECTMIND_ROOT;
      if (typeof projectRoot === 'string') candidates.push(projectRoot);
    }
  }
  return candidates.some((candidate) => isPinnedProjectRootValue(candidate, root));
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
  writeFileAtomically(path, merged.content);
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
    writeFileAtomically(path, merged.content);
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
  writeFileAtomically(path, `${JSON.stringify(merged, null, 2)}\n`);
  return true;
}

/** Read-only verification of the generated entry; never mutates user config. */
export function verifyMcpConfig(
  path: string,
  root: string,
  kind: AgentKind,
): McpConfigVerification {
  const checks: McpConfigVerification['checks'] = [];
  const add = (name: string, status: 'pass' | 'warn' | 'fail', detail: string): void => {
    checks.push({ name, status, detail });
  };
  if (!existsSync(path)) {
    add(
      'config-file',
      'fail',
      'Configuration file does not exist. Run mcp-init without --verify first.',
    );
    return {
      ok: false,
      path,
      format: kind,
      projectmindEntry: false,
      duplicateProjectMindEntries: 0,
      checks,
      nextActions: [`Run pm mcp-init <agent> --force to create ${path}.`],
    };
  }

  if (kind === 'codex') {
    const content = readFileSync(path, 'utf8');
    const occurrences = (content.match(/\[mcp_servers\.projectmind\]/g) ?? []).length;
    const entry =
      occurrences === 1 && content.includes('command = "npx"') && content.includes('"mcp"');
    add(
      'config-syntax',
      content.includes('[mcp_servers.projectmind]') ? 'pass' : 'fail',
      'TOML ProjectMind table marker inspected.',
    );
    add(
      'projectmind-entry',
      entry ? 'pass' : 'fail',
      entry
        ? 'ProjectMind npx/mcp entry is present.'
        : 'ProjectMind command or MCP argument is missing.',
    );
    add(
      'project-root',
      content.includes(`PROJECTMIND_ROOT = ${JSON.stringify(resolve(root))}`) ? 'pass' : 'warn',
      'PROJECTMIND_ROOT should point to the active project root.',
    );
    return {
      ok: checks.every((check) => check.status !== 'fail'),
      path,
      format: kind,
      projectmindEntry: entry,
      duplicateProjectMindEntries: Math.max(0, occurrences - 1),
      checks,
      nextActions: checks.some((check) => check.status === 'fail')
        ? ['Run with --force to replace only the marked ProjectMind block.']
        : [],
    };
  }

  let config: JsonObject;
  try {
    config = readJson(path);
    add('config-syntax', 'pass', 'JSON/JSONC parsed successfully.');
  } catch (error) {
    add('config-syntax', 'fail', error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      path,
      format: kind,
      projectmindEntry: false,
      duplicateProjectMindEntries: 0,
      checks,
      nextActions: ['Fix the JSON/JSONC syntax and rerun --verify.'],
    };
  }

  let entry: JsonValue | undefined;
  let duplicateCount = 0;
  if (kind === 'opencode') {
    const mcp = config.mcp;
    const servers =
      mcp && typeof mcp === 'object' && !Array.isArray(mcp)
        ? (mcp as JsonObject).servers
        : undefined;
    entry =
      servers && typeof servers === 'object' && !Array.isArray(servers)
        ? (servers as JsonObject).projectmind
        : undefined;
  } else if (kind === 'kilo') {
    const mcp = config.mcp;
    entry =
      mcp && typeof mcp === 'object' && !Array.isArray(mcp)
        ? (mcp as JsonObject).projectmind
        : undefined;
  } else {
    const servers = config.mcpServers;
    entry =
      servers && typeof servers === 'object' && !Array.isArray(servers)
        ? (servers as JsonObject).projectmind
        : undefined;
  }
  // Count only structural `projectmind:` keys in the raw config. Counting
  // package names or PROJECTMIND_ROOT values made a valid single entry look
  // duplicated, while JSON.parse alone would silently collapse duplicate
  // object keys and hide the actual config defect.
  const rawConfig = readFileSync(path, 'utf8');
  const structuralEntries = rawConfig.match(/["']projectmind["']\s*:/g) ?? [];
  duplicateCount = Math.max(0, structuralEntries.length - 1);
  const entryRecord =
    entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as JsonObject) : undefined;
  const command = entryRecord?.command;
  const args = entryRecord?.args;
  const commandParts = Array.isArray(command) ? command : Array.isArray(args) ? args : [];
  const commandOk = command === 'npx' || commandParts[0] === 'npx';
  const argsOk =
    commandParts.some(
      (arg) => typeof arg === 'string' && arg.includes('@emirhanturker/projectmind'),
    ) && commandParts.some((arg) => arg === 'mcp');
  const projectRootOk = entryRecord ? hasPinnedProjectRoot(entryRecord, root) : false;
  add(
    'projectmind-entry',
    entryRecord ? 'pass' : 'fail',
    entryRecord
      ? 'ProjectMind entry exists at the expected client location.'
      : 'No ProjectMind entry found at the expected client location.',
  );
  add(
    'command',
    commandOk ? 'pass' : 'fail',
    commandOk ? 'Entry uses npx without a shell wrapper.' : 'Entry command should be npx.',
  );
  add(
    'mcp-argument',
    argsOk ? 'pass' : 'fail',
    argsOk
      ? 'Entry launches the MCP subcommand and package.'
      : 'Entry must contain the ProjectMind package and mcp argument.',
  );
  add(
    'project-root',
    projectRootOk ? 'pass' : 'warn',
    projectRootOk
      ? 'Project root is pinned.'
      : 'PROJECTMIND_ROOT/cwd is not visibly pinned to the active project root.',
  );
  add(
    'duplicate-entry',
    duplicateCount === 0 ? 'pass' : 'warn',
    duplicateCount === 0
      ? 'No duplicate ProjectMind server blocks detected.'
      : `${duplicateCount} possible duplicate ProjectMind mentions detected; inspect before --force.`,
  );
  return {
    ok: checks.every((check) => check.status !== 'fail'),
    path,
    format: kind,
    projectmindEntry: !!entryRecord,
    duplicateProjectMindEntries: duplicateCount,
    checks,
    nextActions: checks.some((check) => check.status === 'fail')
      ? ['Run with --force to update only ProjectMind configuration.']
      : [],
  };
}
