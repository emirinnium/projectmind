import { Command } from 'commander';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { DEFAULT_PMIGNORE_CONTENT } from '@/utils/ignore.js';
import type { ProjectMindConfig } from '@/utils/config.js';
import { getGlobalConfigPath } from '@/utils/config.js';
import { tryValidateConfig } from '@/utils/config-schema.js';
import { validateProjectPath, PathSecurityError } from '@/core/security/path-security.js';
import { writeFileAtomically } from '@/utils/atomic-write.js';

export interface InstallCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  nextAction?: string;
}

export interface InstallDoctorReport {
  success: boolean;
  platform: NodeJS.Platform;
  node: string;
  checks: InstallCheck[];
  fixed: string[];
}

function commandVersion(command: string, args: string[], cwd: string): string | undefined {
  try {
    // Windows .cmd shims are not directly executable with shell:false on all
    // supported Node versions. The command and arguments here are constants
    // owned by this module; route them through cmd.exe without accepting a
    // user-provided command string.
    const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : command;
    const commandArgs =
      process.platform === 'win32' ? ['/d', '/s', '/c', [command, ...args].join(' ')] : args;
    return execFileSync(executable, commandArgs, {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    void error;
    return undefined;
  }
}

function nodeAtLeast22_13(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major > 22 || (major === 22 && (minor > 13 || (minor === 13 && patch >= 0)));
}

/** Read-only install/runtime diagnosis; only creates `.pmignore` with explicit --fix. */
export function inspectInstall(config: ProjectMindConfig, fix = false): InstallDoctorReport {
  const root = config.projectRoot;
  const checks: InstallCheck[] = [];
  const fixed: string[] = [];
  const add = (
    name: string,
    status: InstallCheck['status'],
    detail: string,
    nextAction?: string,
  ): void => {
    checks.push({ name, status, detail, nextAction });
  };
  const node = process.version;
  add(
    'node-version',
    nodeAtLeast22_13(node) ? 'pass' : 'fail',
    `${node}; ProjectMind requires Node >=22.13.0.`,
    'Install/use Node 22.13 or newer, then retry.',
  );
  const npm = commandVersion(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], root);
  add(
    'npm',
    npm ? 'pass' : 'fail',
    npm ? `npm ${npm}` : 'npm executable is not available on PATH.',
    'Install npm with Node.js and restart the shell.',
  );

  const require = createRequire(import.meta.url);
  const requiredDependencies: Array<[string, string]> = [
    ['zod', 'zod'],
    // The SDK intentionally exposes subpath entry points used by ProjectMind;
    // checking the package root alone produces a false failure for SDK builds
    // that omit a root index while shipping server/mcp.js.
    ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/server/mcp.js'],
  ];
  for (const [dependency, resolution] of requiredDependencies) {
    try {
      require.resolve(resolution);
      add(
        `dependency:${dependency}`,
        'pass',
        `${dependency} is resolvable from the installed package.`,
      );
    } catch (error) {
      void error;
      add(
        `dependency:${dependency}`,
        'fail',
        `${dependency} is not resolvable.`,
        'Run npm install without --legacy-peer-deps.',
      );
    }
  }
  for (const optional of ['@huggingface/transformers', 'onnxruntime-node']) {
    try {
      require.resolve(optional);
      add(
        `optional:${optional}`,
        'pass',
        `${optional} is available; embedding/runtime acceleration can be used.`,
      );
    } catch (error) {
      void error;
      add(
        `optional:${optional}`,
        'warn',
        `${optional} is unavailable; core analysis remains usable with the simple provider.`,
        'Install the optional provider only if transformer embeddings are required.',
      );
    }
  }

  const pmignore = join(root, '.pmignore');
  if (existsSync(pmignore))
    add('pmignore', 'pass', '.pmignore is present and is the single source-discovery ignore file.');
  else if (fix) {
    writeFileAtomically(pmignore, DEFAULT_PMIGNORE_CONTENT);
    fixed.push('.pmignore');
    add('pmignore', 'pass', '.pmignore was created with the safe default exclusions.');
  } else
    add(
      'pmignore',
      'warn',
      '.pmignore is missing; built-in exclusions still apply.',
      'Run `pm doctor install --fix` if you want a visible project ignore file.',
    );

  const rc = join(root, '.projectmindrc.json');
  add(
    'project-config',
    existsSync(rc) ? 'pass' : 'warn',
    existsSync(rc)
      ? '.projectmindrc.json is present.'
      : 'No project config file; defaults are active.',
    'Create .projectmindrc.json only for intentional overrides.',
  );
  if (existsSync(rc)) {
    try {
      JSON.parse(readFileSync(rc, 'utf8'));
      add('project-config-syntax', 'pass', '.projectmindrc.json is valid JSON.');
    } catch (error) {
      add(
        'project-config-syntax',
        'fail',
        `Could not parse .projectmindrc.json: ${error instanceof Error ? error.message : String(error)}`,
        'Fix the JSON syntax and rerun `pm doctor install`.',
      );
    }
  }
  const globalConfigPath = getGlobalConfigPath();
  if (!existsSync(globalConfigPath)) {
    add(
      'global-config',
      'warn',
      `No global config found at ${globalConfigPath}; built-in defaults and project overrides remain active.`,
      'Run `projectmind config init --global` to create a sparse user-level config.',
    );
  } else {
    try {
      const globalRaw = JSON.parse(readFileSync(globalConfigPath, 'utf8')) as unknown;
      const globalValid = tryValidateConfig(globalRaw) !== null;
      add(
        'global-config',
        globalValid ? 'pass' : 'fail',
        globalValid
          ? `Global config is valid: ${globalConfigPath}`
          : `Global config failed schema validation: ${globalConfigPath}`,
        globalValid
          ? undefined
          : 'Run `projectmind config show --global` and correct the invalid value.',
      );
      if (process.platform !== 'win32') {
        try {
          const mode = accessMode(globalConfigPath);
          add(
            'global-config-permissions',
            mode === 0o600 ? 'pass' : 'warn',
            mode === 0o600
              ? 'Global config permissions are restricted to the current user (600).'
              : `Global config permissions are ${mode.toString(8)}; 600 is recommended for credentials.`,
            mode === 0o600
              ? undefined
              : 'Run `chmod 600 "' + globalConfigPath + '"` on POSIX systems.',
          );
        } catch (error) {
          add(
            'global-config-permissions',
            'warn',
            `Global config permissions could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      add(
        'global-config',
        'fail',
        `Could not parse global config ${globalConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
        'Run `projectmind config init --global` only after moving or repairing the invalid file.',
      );
    }
  }
  const projectRaw = readOptionalConfigObject(rc);
  const globalRaw = readOptionalConfigObject(globalConfigPath);
  const overriddenKeys =
    projectRaw && globalRaw ? [...projectRaw.keys()].filter((key) => globalRaw.has(key)) : [];
  add(
    'config-precedence',
    overriddenKeys.length > 0 ? 'warn' : 'pass',
    overriddenKeys.length > 0
      ? `Project config intentionally overrides global key(s): ${overriddenKeys.slice(0, 12).join(', ')}${overriddenKeys.length > 12 ? ', …' : ''}.`
      : 'No project/global key collision detected; precedence is defaults < global < project < environment < CLI.',
    overriddenKeys.length > 0
      ? 'Keep only intentional project overrides; use `projectmind config show --effective` to inspect the result.'
      : undefined,
  );
  const localMcpConfigs = [
    '.mcp.json',
    'opencode.json',
    'opencode.jsonc',
    '.kilo/kilo.json',
    '.kilo/kilo.jsonc',
  ].filter((file) => existsSync(join(root, file)));
  add(
    'mcp-config-discovery',
    localMcpConfigs.length > 0 ? 'pass' : 'warn',
    localMcpConfigs.length > 0
      ? `Found local MCP config candidate(s): ${localMcpConfigs.join(', ')}.`
      : 'No project-local MCP config candidate was found; this is valid for stdio clients configured globally.',
    'Run `pm mcp-init <agent> --verify` against the intended client config.',
  );
  let databaseInside = false;
  try {
    validateProjectPath(config.databasePath, root, { allowDirectory: true });
    databaseInside = true;
  } catch (error) {
    if (!(error instanceof PathSecurityError)) throw error;
  }
  add(
    'database-path',
    databaseInside ? 'pass' : 'fail',
    databaseInside
      ? `Database is inside project root: ${config.databasePath}`
      : 'Database path escapes project root.',
    'Use a project-relative databasePath under .projectmind/.',
  );
  const packageJson = join(root, 'package.json');
  add(
    'package-metadata',
    existsSync(packageJson) ? 'pass' : 'warn',
    existsSync(packageJson)
      ? 'package.json is present.'
      : 'package.json is not present in this directory.',
  );

  const prefix = npm
    ? commandVersion(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['config', 'get', 'prefix'],
        root,
      )
    : undefined;
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const pathEntries = pathValue.split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  const globalBin =
    process.platform === 'win32' ? prefix : prefix ? join(prefix, 'bin') : undefined;
  const globalBinVisible =
    !!globalBin &&
    pathEntries.some((entry) =>
      process.platform === 'win32'
        ? entry.toLowerCase() === globalBin.toLowerCase()
        : entry === globalBin,
    );
  add(
    'global-bin-path',
    globalBinVisible ? 'pass' : 'warn',
    globalBin
      ? globalBinVisible
        ? `npm global bin is visible on PATH: ${globalBin}`
        : `npm global bin is not visible on PATH: ${globalBin}`
      : 'npm global prefix could not be determined.',
    'Restart the shell after adding npm global bin to PATH; no legacy peer-deps flag is required.',
  );

  const projectmindExecutable = process.platform === 'win32' ? 'projectmind.cmd' : 'projectmind';
  const pmExecutable = process.platform === 'win32' ? 'pm.cmd' : 'pm';
  const projectmindVersion = commandVersion(projectmindExecutable, ['--version'], root);
  const pmVersion = commandVersion(pmExecutable, ['--version'], root);
  add(
    'projectmind-binary',
    projectmindVersion || pmVersion ? 'pass' : 'warn',
    projectmindVersion || pmVersion
      ? `Global CLI resolves to ${projectmindVersion || pmVersion}.`
      : 'Global projectmind/pm binary is not currently resolvable from PATH.',
    'Run npm i -g @emirhanturker/projectmind and reopen the terminal if a global CLI is desired.',
  );

  try {
    accessSync(root, constants.R_OK | constants.W_OK);
    add(
      'project-permissions',
      'pass',
      'Project root is readable and writable by the current user.',
    );
  } catch (error) {
    add(
      'project-permissions',
      'fail',
      `Project root is not readable/writable: ${error instanceof Error ? error.message : String(error)}`,
      'Choose a readable/writable project directory or adjust its permissions for the current user.',
    );
  }
  return {
    success: checks.every((check) => check.status !== 'fail'),
    platform: process.platform,
    node,
    checks,
    fixed,
  };
}

function accessMode(filePath: string): number {
  // `accessSync` verifies reachability; stat mode is only meaningful on POSIX.
  accessSync(filePath, constants.R_OK);
  return statSync(filePath).mode & 0o777;
}

function readOptionalConfigObject(filePath: string): Map<string, unknown> | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return flattenConfigKeys(value as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

function flattenConfigKeys(value: Record<string, unknown>, prefix = ''): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      for (const [nestedKey, nestedValue] of flattenConfigKeys(
        child as Record<string, unknown>,
        path,
      ))
        result.set(nestedKey, nestedValue);
    } else result.set(path, child);
  }
  return result;
}

export function createDoctorInstallCommand(): Command {
  return new Command('install')
    .description('Diagnose Node/npm, ProjectMind config, providers and PATH')
    .option('-r, --root <path>', 'Project directory; defaults to configured project root')
    .option('--fix', 'Create only the missing safe .pmignore file')
    .option('--format <format>', 'Output format: text|json', 'text')
    .action(async (opts: { root?: string; fix?: boolean; format?: string }) => {
      if (opts.format !== 'text' && opts.format !== 'json')
        throw new Error('--format must be text or json.');
      const { loadConfig } = await import('@/utils/config.js');
      const config = loadConfig(opts.root ? resolve(opts.root) : undefined);
      const report = inspectInstall(
        opts.root ? { ...config, projectRoot: resolve(opts.root) } : config,
        !!opts.fix,
      );
      if (opts.format === 'json') {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      process.stdout.write(`ProjectMind install doctor (${report.platform}, ${report.node})\n`);
      for (const check of report.checks)
        process.stdout.write(
          `${check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗'} ${check.name}: ${check.detail}\n`,
        );
      if (report.fixed.length > 0) process.stdout.write(`Fixed: ${report.fixed.join(', ')}\n`);
      if (!report.success)
        throw new Error(
          'Install doctor found a blocking issue. Follow the nextAction hints above.',
        );
    });
}
