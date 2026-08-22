import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger.js';
import 'dotenv/config';
import { validateConfig, type ProjectMindRc } from './config-schema.js';

export interface ProjectMindConfig {
  projectRoot: string;
  databasePath: string;
  embeddingsDir: string;
  maxDepth: number;
  ignorePatterns: string[];
  llm: {
    provider: string;
    model: string;
    apiKey: string | undefined;
    deepModel: string;
    confidenceThreshold: number;
    maxCacheSize: number;
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
  ignorePatterns: [
    'node_modules/**',
    'dist/**',
    '.git/**',
    '*.min.js',
    '*.map',
    'package-lock.json',
    'yarn.lock',
  ],
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
 * Load and validate configuration from .projectmindrc.json
 * Falls back to defaults for invalid or missing fields.
 */
export function loadConfig(): ProjectMindConfig {
  const configPath = join(process.cwd(), '.projectmindrc.json');
  if (existsSync(configPath)) {
    try {
      const rawContent = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(rawContent);
      
      // Validate with Zod schema
      const validated = validateConfig(parsed as unknown);
      
      // Merge with defaults and resolve API keys from env vars
      const config = mergeWithDefaults(validated);
      return config;
    } catch (e) {
      if (e instanceof SyntaxError) {
        logger.warn('Invalid JSON in .projectmindrc.json, using defaults');
      } else {
        logger.warn(`Failed to load config: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return {
    ...DEFAULT_CONFIG,
    llm: {
      ...DEFAULT_CONFIG.llm,
      apiKey: resolveApiKey(),
    },
  };
}

/**
 * Merge validated ProjectMindRc with defaults to produce ProjectMindConfig
 */
function mergeWithDefaults(validated: ProjectMindRc): ProjectMindConfig {
  const llmConfig = {
    provider: validated.llm?.provider ?? DEFAULT_CONFIG.llm.provider,
    model: validated.llm?.model ?? DEFAULT_CONFIG.llm.model,
    apiKey: resolveApiKey(validated.llm?.apiKey),
    deepModel: validated.llm?.deepModel ?? DEFAULT_CONFIG.llm.deepModel,
    confidenceThreshold: validated.llm?.confidenceThreshold ?? DEFAULT_CONFIG.llm.confidenceThreshold,
    maxCacheSize: validated.llm?.maxCacheSize ?? DEFAULT_CONFIG.llm.maxCacheSize,
  };

  const embeddingsConfig = {
    provider: validated.embeddings?.provider ?? DEFAULT_CONFIG.embeddings.provider,
    unixcoderModelPath: validated.embeddings?.unixcoderModelPath ?? DEFAULT_CONFIG.embeddings.unixcoderModelPath,
    codebertModelPath: validated.embeddings?.codebertModelPath ?? DEFAULT_CONFIG.embeddings.codebertModelPath,
    dimension: validated.embeddings?.dimension ?? DEFAULT_CONFIG.embeddings.dimension,
    openaiApiKey: validated.embeddings?.openaiApiKey,
    openaiModel: validated.embeddings?.openaiModel ?? DEFAULT_CONFIG.embeddings.openaiModel,
    transformersModel: validated.embeddings?.transformersModel ?? DEFAULT_CONFIG.embeddings.transformersModel,
  };

  const featuresConfig = {
    coherenceEngine: validated.features?.coherenceEngine ?? DEFAULT_CONFIG.features.coherenceEngine,
    debtTracker: validated.features?.debtTracker ?? DEFAULT_CONFIG.features.debtTracker,
    scaleManager: validated.features?.scaleManager ?? DEFAULT_CONFIG.features.scaleManager,
    memoryBridge: validated.features?.memoryBridge ?? DEFAULT_CONFIG.features.memoryBridge,
  };

  return {
    projectRoot: validated.projectRoot ?? DEFAULT_CONFIG.projectRoot,
    databasePath: validated.databasePath ?? DEFAULT_CONFIG.databasePath,
    embeddingsDir: validated.embeddingsDir ?? DEFAULT_CONFIG.embeddingsDir,
    maxDepth: validated.maxDepth ?? DEFAULT_CONFIG.maxDepth,
    ignorePatterns: validated.ignorePatterns ?? DEFAULT_CONFIG.ignorePatterns,
    llm: llmConfig,
    embeddings: embeddingsConfig,
    features: featuresConfig,
    scanOnStartup: validated.scanOnStartup ?? DEFAULT_CONFIG.scanOnStartup,
  };
}

/**
 * Resolve API key from config or environment variables
 */
function resolveApiKey(configApiKey?: string): string | undefined {
  if (configApiKey) return configApiKey;
  return process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY
    || process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY
    || process.env.OPENAI_API_KEY;
}

export function getConfigPath(): string {
  return join(process.cwd(), '.projectmind');
}
