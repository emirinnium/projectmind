import { reportSuppressedError } from './errors.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, basename, sep, isAbsolute } from 'node:path';
import { logger } from './logger.js';
import { normalizePath } from './paths.js';
import 'dotenv/config';
import {
  tryValidateConfig,
  getDefaults,
  type ProjectMindRc,
  SECRET_KEYS,
} from './config-schema.js';

export interface ProjectMindConfig {
  projectRoot: string;
  databasePath: string;
  embeddingsDir: string;
  maxDepth: number;
  llm: {
    provider: string;
    model: string;
    apiKey: string | undefined;
    endpoint?: string;
    deepModel: string;
    confidenceThreshold: number;
    maxCacheSize: number;
    reasoning?: {
      effort?: 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';
      maxTokens?: number;
      exclude?: boolean;
    };
    pricing?: {
      inputPricePer1k: number;
      outputPricePer1k?: number;
      currency: 'USD';
      source?: string;
      effectiveAt?: string;
      expiresAt?: string;
    };
  };
  embeddings: {
    provider: 'simple' | 'openai' | 'transformers' | 'unixcoder' | 'codebert';
    unixcoderModelPath: string;
    codebertModelPath: string;
    dimension: number;
    openaiApiKey: string | undefined;
    openaiModel: string;
    transformersModel: string;
  };
  features: {
    coherenceEngine: boolean;
    debtTracker: boolean;
    scaleManager: boolean;
    memoryBridge: boolean;
  };
  scanOnStartup?: boolean;
}

const DEFAULT_CONFIG: ProjectMindConfig = {
  projectRoot: process.env.PROJECTMIND_ROOT || process.cwd(),
  databasePath: '.projectmind/pm-knowledge.db',
  embeddingsDir: '.projectmind/embeddings',
  maxDepth: 10,
  llm: {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    apiKey: undefined,
    deepModel: 'claude-3-opus-20240229',
    confidenceThreshold: 0.7,
    maxCacheSize: 10000,
  },
  embeddings: {
    provider: 'simple',
    unixcoderModelPath: 'models/unixcoder-base.onnx',
    codebertModelPath: 'models/codebert-base.onnx',
    dimension: 768,
    openaiApiKey: undefined,
    openaiModel: 'text-embedding-3-small',
    transformersModel: 'Xenova/all-MiniLM-L6-v2',
  },
  features: {
    coherenceEngine: true,
    debtTracker: true,
    scaleManager: true,
    memoryBridge: true,
  },
  scanOnStartup: true,
};

/**
 * Get the global config file path (XDG-compliant with win32 fallback)
 */
function getGlobalConfigPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    return join(xdgConfigHome, 'projectmind', 'config.json');
  }
  if (process.platform === 'win32') {
    const home = process.env.USERPROFILE || homedir();
    return join(home, 'AppData', 'Roaming', 'projectmind', 'config.json');
  }
  return join(homedir(), '.config', 'projectmind', 'config.json');
}

/**
 * Get the project config file path
 */
function getProjectConfigPath(startDirectory = process.cwd()): string {
  let directory = resolve(startDirectory);
  while (true) {
    const candidate = join(directory, '.projectmindrc.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  // A --root-style caller must never fall back to the invoking cwd's project
  // config. That would leak unrelated project settings into the selected
  // root when the selected project has no local config yet.
  return join(resolve(startDirectory), '.projectmindrc.json');
}

/**
 * Check if project config contains secrets and warn if git-tracked
 */
function checkSecretHygiene(projectRaw: unknown, projectPath: string): void {
  if (!projectRaw || typeof projectRaw !== 'object') return;

  const raw = projectRaw as Record<string, unknown>;
  const llm = isPlainObject(raw.llm) ? raw.llm : undefined;
  const embeddings = isPlainObject(raw.embeddings) ? raw.embeddings : undefined;
  for (const key of SECRET_KEYS) {
    if (llm?.[key] || embeddings?.[key]) {
      logger.warn(
        `apiKey found in project config (${projectPath}). ` +
          `This file may be git-tracked. Use 'pm config set --global' or environment variables instead.`,
      );
      return;
    }
  }
}

/**
 * Load raw global config without applying Zod defaults (sparse).
 * Used internally for correct precedence: raw layers are merged before a single validation.
 */
function loadGlobalConfigRaw(): { parsed: unknown; path: string } | null {
  const globalPath = getGlobalConfigPath();
  if (!existsSync(globalPath)) return null;

  try {
    const content = readFileSync(globalPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;

    // Check permissions on POSIX systems
    if (process.platform !== 'win32') {
      try {
        const stats = statSync(globalPath);
        const mode = stats.mode & 0o777;
        if (mode !== 0o600) {
          logger.warn(`Global config file permissions are ${mode.toString(8)}, expected 600`);
        }
      } catch (error) {
        reportSuppressedError(error, 'Intentional fallback src/utils/config.ts:147');
        // stat may fail, non-blocking
      }
    }

    return { parsed, path: globalPath };
  } catch (error) {
    logger.warn(
      `Invalid global config at ${globalPath}: ${error instanceof Error ? error.message : String(error)}. Using defaults.`,
    );
    return null;
  }
}

/**
 * Load and validate global config from ~/.config/projectmind/config.json
 * @deprecated Prefer loadGlobalConfigRaw for precedence-aware merging; this shim retains backward compatibility.
 */
function loadGlobalConfig(): ProjectMindRc | null {
  const raw = loadGlobalConfigRaw();
  if (!raw) return null;
  return tryValidateConfig(raw.parsed);
}

/**
 * Load raw project config without validation
 */
function loadProjectConfigRaw(
  startDirectory = process.cwd(),
): { parsed: unknown; path: string } | null {
  const projectPath = getProjectConfigPath(startDirectory);
  if (!existsSync(projectPath)) return null;

  try {
    const content = readFileSync(projectPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    if (isPlainObject(parsed) && 'ignorePatterns' in parsed) {
      logger.warn(
        `The ignorePatterns setting in ${projectPath} is no longer used. Move those rules to .pmignore.`,
      );
    }
    return { parsed, path: projectPath };
  } catch (error) {
    logger.warn(
      `Invalid project config at ${projectPath}: ${error instanceof Error ? error.message : String(error)}. Using defaults.`,
    );
    return null;
  }
}

/**
 * Type-safe deep merge for plain-object records. Used at the raw-config
 * boundary where we explicitly accept `unknown` shape (raw JSON).
 */
type AnyRecord = Record<string, unknown>;

function isPlainObject(v: unknown): v is AnyRecord {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep merge multiple raw configs with later configs overriding earlier ones.
 * Works on sparse (raw JSON) objects so Zod defaults are not densified before precedence.
 */
function mergeConfigs(...configs: (AnyRecord | null | undefined)[]): AnyRecord {
  const result: AnyRecord = {};
  for (const config of configs) {
    if (!config || !isPlainObject(config)) continue;
    for (const key of Object.keys(config)) {
      const value = config[key];
      if (isPlainObject(value)) {
        const existing = result[key];
        const merged = isPlainObject(existing) ? { ...existing, ...value } : { ...value };
        result[key] = merged;
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * Apply CLI overrides to a validated config. Nested plain objects are deep
 * merged; primitives and arrays replace.
 */
function applyCliOverrides(
  config: ProjectMindConfig,
  cliOverrides: Partial<ProjectMindRc>,
): ProjectMindConfig {
  const target = config as unknown as AnyRecord;
  for (const key of Object.keys(cliOverrides) as Array<keyof ProjectMindRc>) {
    const value = cliOverrides[key] as unknown;
    if (isPlainObject(value)) {
      const existing = target[key];
      target[key] = isPlainObject(existing) ? { ...existing, ...value } : { ...value };
    } else if (value !== undefined) {
      target[key] = value;
    }
  }
  return config;
}

/**
 * Load config with full precedence: defaults < global < project < env < CLI overrides
 * Precedence fix (B1): merge RAW JSON sparsely, then validate the merged result once
 * so Zod defaults do not densify layers and incorrectly override globals.
 */
function loadEffectiveConfig(
  cliOverrides?: Partial<ProjectMindRc>,
  workingDirectory = process.cwd(),
): ProjectMindConfig {
  // 1. Load raw global + project configs (no Zod defaults applied yet)
  const globalRaw = loadGlobalConfigRaw();
  const projectRaw = loadProjectConfigRaw(workingDirectory);

  // 2. Check secret hygiene for project file (raw)
  if (projectRaw) {
    checkSecretHygiene(projectRaw.parsed, projectRaw.path);
  }

  // 3. Merge raw layers sparsely: defaults < global < project
  const mergedRaw = mergeConfigs(
    (globalRaw?.parsed as AnyRecord | undefined) ?? null,
    (projectRaw?.parsed as AnyRecord | undefined) ?? null,
  );

  // A project config discovered in a parent directory owns relative paths.
  // Resolve its projectRoot against that config location so invoking `pm`
  // from a nested package does not silently analyze the nested cwd instead.
  const projectRootValue = isPlainObject(projectRaw?.parsed)
    ? projectRaw.parsed.projectRoot
    : undefined;
  const globalRootValue = isPlainObject(globalRaw?.parsed)
    ? globalRaw.parsed.projectRoot
    : undefined;
  if (
    projectRaw?.path &&
    typeof projectRootValue === 'string' &&
    projectRootValue.trim() !== '' &&
    projectRootValue !== '.' &&
    !isAbsolute(projectRootValue)
  ) {
    mergedRaw.projectRoot = resolve(dirname(projectRaw.path), projectRootValue);
  } else if (
    projectRaw?.path &&
    (projectRootValue === undefined || projectRootValue === '.') &&
    (globalRootValue === undefined || globalRootValue === '.')
  ) {
    mergedRaw.projectRoot = dirname(projectRaw.path);
  }

  // 4. Validate merged result once — Zod defaults applied only here
  const validated = tryValidateConfig(mergedRaw);
  const mergedRc = (validated ?? getDefaults()) as ProjectMindRc;

  // 5. Apply existing mergeWithDefaults logic (handles env vars via resolveApiKey, path normalization, etc.)
  const config = mergeWithDefaults(mergedRc, workingDirectory);

  // 6. Apply CLI overrides (if any)
  if (cliOverrides) {
    applyCliOverrides(config, cliOverrides);
  }

  return config;
}

/**
 * Load and validate configuration from .projectmindrc.json
 * Falls back to defaults for invalid or missing fields.
 *
 * @deprecated Use loadEffectiveConfig() for full precedence support
 */
export function loadConfig(workingDirectory = process.cwd()): ProjectMindConfig {
  return loadEffectiveConfig(undefined, workingDirectory);
}

/**
 * Normalize a state path (databasePath / embeddingsDir) so the resolved path is
 * ALWAYS inside `join(projectRoot, '.projectmind')`.
 *
 * - Empty/undefined/whitespace → fallback.
 * - Absolute path → relocated under `.projectmind/` (basename only).
 * - Relative path that escapes `.projectmind/` (e.g. bare `pm-knowledge.db`
 *   resolving to projectRoot, or `../x.db` resolving to a parent) → forced
 *   under `.projectmind/`.
 * - Relative path already under `.projectmind/` (possibly nested deeper) →
 *   returned unchanged.
 *
 * Returns a path RELATIVE TO projectRoot.
 */
function normalizeStatePath(
  raw: string | undefined,
  fallback: string,
  projectRoot: string,
): string {
  if (raw === undefined || raw.trim() === '') {
    return normalizePath(fallback);
  }

  if (isAbsolute(raw)) {
    logger.warn(
      `Config path "${raw}" is absolute; relocating to .projectmind/${basename(raw)} to keep state inside the project.`,
    );
    return normalizePath(join('.projectmind', basename(raw)));
  }

  const resolved = resolve(projectRoot, raw);
  const targetDir = resolve(projectRoot, '.projectmind');
  if (resolved !== targetDir && !resolved.startsWith(targetDir + sep)) {
    logger.warn(
      `Config path "${raw}" resolves outside .projectmind/; relocating to .projectmind/${basename(resolved) || basename(fallback)}.`,
    );
    return normalizePath(join('.projectmind', basename(resolved) || basename(fallback)));
  }

  return normalizePath(raw);
}

/**
 * Merge validated ProjectMindRc with defaults to produce ProjectMindConfig
 */
export function mergeWithDefaults(
  validated: ProjectMindRc,
  defaultProjectRoot = process.cwd(),
): ProjectMindConfig {
  const provider = validated.llm?.provider ?? DEFAULT_CONFIG.llm.provider;
  const llmConfig: ProjectMindConfig['llm'] = {
    provider,
    model: validated.llm?.model ?? DEFAULT_CONFIG.llm.model,
    apiKey: resolveApiKey(validated.llm?.apiKey, provider),
    deepModel: validated.llm?.deepModel ?? DEFAULT_CONFIG.llm.deepModel,
    confidenceThreshold:
      validated.llm?.confidenceThreshold ?? DEFAULT_CONFIG.llm.confidenceThreshold,
    maxCacheSize: validated.llm?.maxCacheSize ?? DEFAULT_CONFIG.llm.maxCacheSize,
    reasoning: validated.llm?.reasoning,
    pricing: validated.llm?.pricing,
  };
  // Include endpoint only if defined (it's optional)
  if (validated.llm?.endpoint) {
    llmConfig.endpoint = validated.llm.endpoint;
  }

  const embeddingsConfig = {
    provider: validated.embeddings?.provider ?? DEFAULT_CONFIG.embeddings.provider,
    unixcoderModelPath:
      validated.embeddings?.unixcoderModelPath ?? DEFAULT_CONFIG.embeddings.unixcoderModelPath,
    codebertModelPath:
      validated.embeddings?.codebertModelPath ?? DEFAULT_CONFIG.embeddings.codebertModelPath,
    dimension: validated.embeddings?.dimension ?? DEFAULT_CONFIG.embeddings.dimension,
    openaiApiKey: validated.embeddings?.openaiApiKey ?? process.env.OPENAI_API_KEY,
    openaiModel: validated.embeddings?.openaiModel ?? DEFAULT_CONFIG.embeddings.openaiModel,
    transformersModel:
      validated.embeddings?.transformersModel ?? DEFAULT_CONFIG.embeddings.transformersModel,
  };

  const featuresConfig = {
    coherenceEngine: validated.features?.coherenceEngine ?? DEFAULT_CONFIG.features.coherenceEngine,
    debtTracker: validated.features?.debtTracker ?? DEFAULT_CONFIG.features.debtTracker,
    scaleManager: validated.features?.scaleManager ?? DEFAULT_CONFIG.features.scaleManager,
    memoryBridge: validated.features?.memoryBridge ?? DEFAULT_CONFIG.features.memoryBridge,
  };

  // Fix B1 projectRoot '.' vs cwd: Zod default '.' would otherwise override
  // the caller's working directory. This is important for commands such as
  // `context-budget --root`, which must not read config from the invoking cwd.
  const effectiveProjectRoot = resolve(
    validated.projectRoot && validated.projectRoot !== '.'
      ? validated.projectRoot
      : defaultProjectRoot,
  );
  return {
    projectRoot: effectiveProjectRoot,
    databasePath: normalizeStatePath(
      validated.databasePath,
      DEFAULT_CONFIG.databasePath,
      effectiveProjectRoot,
    ),
    embeddingsDir: normalizeStatePath(
      validated.embeddingsDir,
      DEFAULT_CONFIG.embeddingsDir,
      effectiveProjectRoot,
    ),
    maxDepth: validated.maxDepth ?? DEFAULT_CONFIG.maxDepth,
    llm: llmConfig,
    embeddings: embeddingsConfig,
    features: featuresConfig,
    scanOnStartup: validated.scanOnStartup ?? DEFAULT_CONFIG.scanOnStartup,
  };
}

/**
 * Resolve API key for a specific LLM provider from config or environment variables.
 * Keys are resolved PER PROVIDER so one provider's credential is never sent to another.
 */
function resolveApiKey(configApiKey?: string, provider?: string): string | undefined {
  if (configApiKey) return configApiKey;
  const p = provider ?? DEFAULT_CONFIG.llm.provider;
  switch (p) {
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'openrouter':
      return process.env.OPENROUTER_API_KEY;
    case 'gemini':
      return process.env.GEMINI_API_KEY;
    case 'groq':
      return process.env.GROQ_API_KEY;
    case 'ollama':
      return undefined; // self-hosted, no key needed
    default:
      return undefined;
  }
}

export function getConfigPath(): string {
  return join(loadConfig().projectRoot, '.projectmind');
}

export {
  getGlobalConfigPath,
  getProjectConfigPath,
  loadGlobalConfig,
  loadGlobalConfigRaw,
  loadEffectiveConfig,
  loadProjectConfigRaw,
};
