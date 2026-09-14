import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  getGlobalConfigPath,
  getProjectConfigPath,
  loadEffectiveConfig,
  loadGlobalConfigRaw,
  loadProjectConfigRaw,
} from '@/utils/config.js';
import { SECRET_KEYS, tryValidateConfig } from '@/utils/config-schema.js';
import { writeFileAtomically } from '@/utils/atomic-write.js';
import { output, asyncHandler } from '@/cli/utils/shared.js';

type ConfigScope = 'global' | 'project';
type ConfigRecord = Record<string, unknown>;

const ALLOWED_KEYS = new Set([
  'projectRoot',
  'databasePath',
  'embeddingsDir',
  'maxDepth',
  'scanOnStartup',
  'llm.provider',
  'llm.model',
  'llm.apiKey',
  'llm.endpoint',
  'llm.deepModel',
  'llm.confidenceThreshold',
  'llm.maxCacheSize',
  'llm.pricing',
  'embeddings.provider',
  'embeddings.unixcoderModelPath',
  'embeddings.codebertModelPath',
  'embeddings.dimension',
  'embeddings.openaiApiKey',
  'embeddings.openaiModel',
  'embeddings.transformersModel',
  'features.coherenceEngine',
  'features.debtTracker',
  'features.scaleManager',
  'features.memoryBridge',
  'contracts',
  'kiloIntegration',
]);

function isRecord(value: unknown): value is ConfigRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseConfigObject(filePath: string): ConfigRecord {
  if (!existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Could not parse config ${filePath}: ${error instanceof Error ? error.message : String(error)}. Fix the JSON syntax and retry.`,
    );
  }
  if (!isRecord(parsed)) throw new Error(`Config ${filePath} must contain a JSON object.`);
  return parsed;
}

function configPath(scope: ConfigScope): string {
  return scope === 'global' ? getGlobalConfigPath() : getProjectConfigPath();
}

function writeConfigObject(filePath: string, config: ConfigRecord): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileAtomically(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

/** Create an empty/sparse config without overwriting user-owned data. */
export function initializeConfigFile(filePath: string, initial: ConfigRecord = {}): boolean {
  if (existsSync(filePath)) return false;
  writeConfigObject(filePath, initial);
  return true;
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** Update a schema-allowlisted dotted key and validate the complete sparse object. */
export function setConfigFileValue(filePath: string, key: string, rawValue: string): ConfigRecord {
  if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(key)) {
    throw new Error(`Invalid config key "${key}". Use a dotted key such as llm.model.`);
  }
  if (!ALLOWED_KEYS.has(key)) {
    throw new Error(
      `Unsupported config key "${key}". Run "projectmind config show" to inspect supported settings.`,
    );
  }
  const config = parseConfigObject(filePath);
  const parts = key.split('.');
  let target = config;
  for (const part of parts.slice(0, -1)) {
    const current = target[part];
    if (current !== undefined && !isRecord(current)) {
      throw new Error(`Cannot set ${key}: ${part} is not an object in ${filePath}.`);
    }
    if (!isRecord(current)) target[part] = {};
    target = target[part] as ConfigRecord;
  }
  target[parts.at(-1)!] = parseValue(rawValue);
  if (!tryValidateConfig(config)) {
    throw new Error(`Invalid value for ${key}. Use JSON for booleans, numbers and arrays.`);
  }
  writeConfigObject(filePath, config);
  return config;
}

export function redactConfigSecrets(value: unknown, key?: string): unknown {
  if (key && SECRET_KEYS.includes(key as (typeof SECRET_KEYS)[number])) return '<redacted>';
  if (Array.isArray(value)) return value.map((item) => redactConfigSecrets(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactConfigSecrets(entryValue, entryKey),
    ]),
  );
}

function chooseScope(options: { global?: boolean; project?: boolean }): ConfigScope {
  if (options.global && options.project)
    throw new Error('Choose only one of --global or --project.');
  return options.global ? 'global' : 'project';
}

function rawForScope(scope: ConfigScope): unknown {
  return scope === 'global'
    ? (loadGlobalConfigRaw()?.parsed ?? {})
    : (loadProjectConfigRaw()?.parsed ?? {});
}

export function createConfigCommand(): Command {
  const command = new Command('config').description(
    'Inspect and manage layered ProjectMind config',
  );

  command
    .command('path')
    .description('Print the config file path')
    .option('--global', 'Use the user-level config path')
    .option('--project', 'Use the current project config path')
    .action((options: { global?: boolean; project?: boolean }) => {
      output.raw(configPath(chooseScope(options)));
    });

  command
    .command('init')
    .description('Create a sparse config file without overwriting an existing one')
    .option('--global', 'Create the user-level config (recommended for shared defaults)')
    .option('--project', 'Create the current project override config')
    .action((options: { global?: boolean; project?: boolean }) => {
      const scope = chooseScope(options);
      const path = configPath(scope);
      const created = initializeConfigFile(
        path,
        scope === 'project' ? { description: 'ProjectMind config' } : {},
      );
      if (created) output.success(`${scope} config created: ${path}`);
      else output.info(`${scope} config already exists: ${path}`);
    });

  command
    .command('show')
    .description('Show global, project or effective config with secrets redacted')
    .option('--global', 'Show only the user-level config')
    .option('--project', 'Show only the nearest project config')
    .option('--effective', 'Show the merged effective config (default)')
    .option('--format <format>', 'Output format: text|json', 'text')
    .action(
      asyncHandler(
        async (options: {
          global?: boolean;
          project?: boolean;
          effective?: boolean;
          format: string;
        }) => {
          if (!['text', 'json'].includes(options.format))
            throw new Error('--format must be text or json.');
          if (options.global && options.project)
            throw new Error('Choose only one of --global or --project.');
          const scope = options.global ? 'global' : options.project ? 'project' : undefined;
          const value = redactConfigSecrets(scope ? rawForScope(scope) : loadEffectiveConfig());
          if (options.format === 'json') {
            output.json(value);
            return;
          }
          output.section(scope ? `${scope} config` : 'effective config');
          output.raw(JSON.stringify(value, null, 2));
        },
      ),
    );

  command
    .command('set')
    .description('Set a validated config value; strings may be plain or JSON-quoted')
    .argument('<key>', 'Allowlisted key, for example llm.model or maxDepth')
    .argument('<value>', 'Value; use JSON syntax for booleans, numbers and arrays')
    .option('--global', 'Update the user-level config')
    .option('--project', 'Update the current project override config (default)')
    .action(
      asyncHandler(
        async (key: string, value: string, options: { global?: boolean; project?: boolean }) => {
          const scope = chooseScope(options);
          const path = configPath(scope);
          const config = setConfigFileValue(path, key, value);
          const isSecret = SECRET_KEYS.includes(
            key.split('.').at(-1)! as (typeof SECRET_KEYS)[number],
          );
          output.success(`Updated ${scope} config: ${key}`);
          if (isSecret)
            output.warn('Secret value was written but will be redacted by config show.');
          output.info(`Config file: ${path}`);
          void config;
        },
      ),
    );

  return command;
}
