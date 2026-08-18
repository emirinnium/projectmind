import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../cli/utils/logger.js';

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
  features: {
    coherenceEngine: true,
    debtTracker: true,
    scaleManager: true,
    memoryBridge: true,
  },
  scanOnStartup: true,
};

export function loadConfig(): ProjectMindConfig {
  const configPath = join(process.cwd(), '.projectmindrc.json');
  if (existsSync(configPath)) {
    try {
      const userConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      return { ...DEFAULT_CONFIG, ...userConfig };
    } catch (e) {
      logger.warn('Invalid .projectmindrc.json, using defaults');
    }
  }

  return {
    ...DEFAULT_CONFIG,
    llm: {
      ...DEFAULT_CONFIG.llm,
      apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY,
    },
  };
}

export function getConfigPath(): string {
  return join(process.cwd(), '.projectmind');
}
