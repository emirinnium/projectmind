import { z } from 'zod';
import { logger } from './logger.js';

/**
 * Zod schema for .projectmindrc.json validation
 */

const LLMConfigSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'gemini', 'groq', 'ollama']).default('anthropic'),
  model: z.string().min(1).default('claude-3-5-sonnet-20241022'),
  apiKey: z.string().optional(),
  deepModel: z.string().min(1).default('claude-3-opus-20240229'),
  confidenceThreshold: z.number().min(0).max(1).default(0.7),
  maxCacheSize: z.number().int().positive().default(10000),
});

const EmbeddingsConfigSchema = z.object({
  provider: z.enum(['simple', 'openai', 'transformers', 'unixcoder', 'codebert']).default('simple'),
  unixcoderModelPath: z.string().default('models/unixcoder-base.onnx'),
  codebertModelPath: z.string().default('models/codebert-base.onnx'),
  dimension: z.number().int().positive().default(768),
  openaiApiKey: z.string().optional(),
  openaiModel: z.string().default('text-embedding-3-small'),
  transformersModel: z.string().default('Xenova/all-MiniLM-L6-v2'),
});

const FeaturesConfigSchema = z.object({
  coherenceEngine: z.boolean().default(true),
  debtTracker: z.boolean().default(true),
  scaleManager: z.boolean().default(true),
  memoryBridge: z.boolean().default(true),
});

const ProjectMindRcSchema = z.object({
  projectRoot: z.string().default('.'),
  databasePath: z.string().default('.projectmind/pm-knowledge.db'),
  embeddingsDir: z.string().default('.projectmind/embeddings'),
  maxDepth: z.number().int().positive().default(10),
  ignorePatterns: z.array(z.string()).default([
    'node_modules/**',
    'dist/**',
    'dist-tests/**',
    '.git/**',
    '.kilo/**',
    '*.min.js',
    '*.map',
    'package-lock.json',
    'yarn.lock',
    'coverage/**',
    '.turbo/**',
  ]),
  llm: LLMConfigSchema.optional(),
  embeddings: EmbeddingsConfigSchema.optional(),
  features: FeaturesConfigSchema.optional(),
  scanOnStartup: z.boolean().default(true),
  contracts: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    sourcePattern: z.string().min(1),
    forbiddenImports: z.array(z.string()).optional(),
    forbiddenKeywords: z.array(z.string()).optional(),
    requiredImports: z.array(z.string()).optional(),
    maxLines: z.number().int().positive().optional(),
    severity: z.enum(['error', 'warning']).default('warning'),
  })).optional(),
  kiloIntegration: z.object({
    autoScanOnSessionStart: z.boolean().default(true),
    syncOnEdit: z.boolean().default(true),
    coherenceCheckOnEdit: z.boolean().default(true),
    preCommitGate: z.boolean().default(true),
    genomeThreshold: z.number().min(0).max(100).default(60),
    maxHighDebt: z.number().int().nonnegative().default(0),
    maxMediumDebt: z.number().int().nonnegative().default(10),
  }).optional(),
});

export type ProjectMindRc = z.infer<typeof ProjectMindRcSchema>;

/**
 * Get default config values
 */
function getDefaults(): ProjectMindRc & { llm: NonNullable<ProjectMindRc['llm']>; embeddings: NonNullable<ProjectMindRc['embeddings']>; features: NonNullable<ProjectMindRc['features']> } {
  return {
    projectRoot: '.',
    databasePath: '.projectmind/pm-knowledge.db',
    embeddingsDir: '.projectmind/embeddings',
    maxDepth: 10,
    ignorePatterns: [
      'node_modules/**',
      'dist/**',
      'dist-tests/**',
      '.git/**',
      '.kilo/**',
      '*.min.js',
      '*.map',
      'package-lock.json',
      'yarn.lock',
      'coverage/**',
      '.turbo/**',
    ],
    llm: {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      deepModel: 'claude-3-opus-20240229',
      confidenceThreshold: 0.7,
      maxCacheSize: 10000,
    },
    embeddings: {
      provider: 'simple',
      unixcoderModelPath: 'models/unixcoder-base.onnx',
      codebertModelPath: 'models/codebert-base.onnx',
      dimension: 768,
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
}

/**
 * Validate and parse .projectmindrc.json content
 */
export function validateConfig(configJson: unknown): ProjectMindRc & { llm: NonNullable<ProjectMindRc['llm']>; embeddings: NonNullable<ProjectMindRc['embeddings']>; features: NonNullable<ProjectMindRc['features']> } {
  // Handle null/undefined input by converting to empty object
  const input = (configJson === null || configJson === undefined) ? {} : configJson;

  const result = ProjectMindRcSchema.safeParse(input);
  if (!result.success) {
    const errors = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    logger.warn(`Invalid .projectmindrc.json:\n${errors}\nUsing defaults for invalid fields.`);
    return getDefaults();
  }

  // Merge validated data with defaults for nested objects
  const data = result.data;
  return {
    ...data,
    llm: data.llm ?? getDefaults().llm,
    embeddings: data.embeddings ?? getDefaults().embeddings,
    features: data.features ?? getDefaults().features,
  };
}

export { LLMConfigSchema, EmbeddingsConfigSchema, FeaturesConfigSchema };
