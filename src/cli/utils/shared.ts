import { loadConfig } from '../../utils/config.js';
import { initDatabase, closeDatabase } from '../../storage/database.js';
import { SCHEMA_SQL } from '../../storage/schema.js';
import { KnowledgeGraph } from '../../storage/knowledge-graph.js';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { logger } from './logger.js';
import { Command } from 'commander';

/**
 * Shared CLI utilities to reduce import coupling and boilerplate across command modules
 */

// Type for context functions
export type ContextFn<T> = (ctx: CLIContext, service: T) => Promise<void>;

export interface CLIContext {
  config: ReturnType<typeof loadConfig>;
  db: any;
  kg: KnowledgeGraph;
}

/**
 * Creates and initializes database connection with KnowledgeGraph
 */
export async function createContext(): Promise<CLIContext> {
  const config = loadConfig();
  const dbPath = join(config.projectRoot, config.databasePath);
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }
  const db = initDatabase(dbPath);
  db.exec(SCHEMA_SQL);
  const kg = new KnowledgeGraph(db);
  return { config, db, kg };
}

/**
 * Closes the database connection
 */
export function closeContext(ctx: CLIContext): void {
  if (ctx?.db) {
    closeDatabase();
  }
}

/**
 * Generic wrapper for CLI commands that need database access
 * Handles context creation, error handling, and cleanup
 */
export async function withContext<T>(
  fn: (ctx: CLIContext) => Promise<T>
): Promise<T> {
  const ctx = await createContext();
  try {
    return await fn(ctx);
  } finally {
    closeContext(ctx);
  }
}

/**
 * Wrapper for commands needing ScaleManager
 */
export async function withScale(fn: ContextFn<any>): Promise<void> {
  await withContext(async (ctx) => {
    const { ScaleManager } = await import('../../core/scale-manager.js');
    const scale = new ScaleManager(ctx.db, ctx.kg);
    await fn(ctx, scale);
  });
}

/**
 * Wrapper for commands needing DebtTracker
 */
export async function withDebt(fn: ContextFn<any>): Promise<void> {
  await withContext(async (ctx) => {
    const { DebtTracker } = await import('../../core/debt-tracker.js');
    const { CoherenceEngine } = await import('../../core/coherence-engine.js');
    const coherence = new CoherenceEngine(ctx.db);
    const debt = new DebtTracker(ctx.db, ctx.kg, coherence);
    await fn(ctx, debt);
  });
}

/**
 * Wrapper for commands needing CoherenceEngine
 */
export async function withCoherence(fn: ContextFn<any>): Promise<void> {
  await withContext(async (ctx) => {
    const { CoherenceEngine } = await import('../../core/coherence-engine.js');
    const { createLLMProvider } = await import('../../core/llm-providers.js');
    const coherence = new CoherenceEngine(ctx.db);
    const llmConfig = {
      provider: ctx.config.llm.provider,
      model: ctx.config.llm.model,
      apiKey: ctx.config.llm.apiKey,
      deepModel: ctx.config.llm.deepModel,
    };
    const llmProvider = createLLMProvider(llmConfig);
    if (llmProvider) {
      coherence.setLLMProvider(llmProvider);
    }
    await fn(ctx, coherence);
  });
}

/**
 * Wrapper for commands needing multiple services
 */
export async function withServices(
  services: ('scale' | 'debt' | 'coherence')[],
  fn: (ctx: CLIContext, services: Record<string, any>) => Promise<void>
): Promise<void> {
  await withContext(async (ctx) => {
    const serviceMap: Record<string, any> = {};
    
    if (services.includes('scale')) {
      const { ScaleManager } = await import('../../core/scale-manager.js');
      serviceMap.scale = new ScaleManager(ctx.db, ctx.kg);
    }
    
    if (services.includes('debt')) {
      const { DebtTracker } = await import('../../core/debt-tracker.js');
      const { CoherenceEngine } = await import('../../core/coherence-engine.js');
      const coherence = new CoherenceEngine(ctx.db);
      serviceMap.debt = new DebtTracker(ctx.db, ctx.kg, coherence);
      serviceMap.coherence = coherence;
    }
    
    if (services.includes('coherence')) {
      const { CoherenceEngine } = await import('../../core/coherence-engine.js');
      const { createLLMProvider } = await import('../../core/llm-providers.js');
      const coherence = new CoherenceEngine(ctx.db);
      const llmConfig = {
        provider: ctx.config.llm.provider,
        model: ctx.config.llm.model,
        apiKey: ctx.config.llm.apiKey,
        deepModel: ctx.config.llm.deepModel,
      };
      const llmProvider = createLLMProvider(llmConfig);
      if (llmProvider) {
        coherence.setLLMProvider(llmProvider);
      }
      serviceMap.coherence = coherence;
    }
    
    await fn(ctx, serviceMap);
  });
}

/**
 * Common output formatting helpers
 */
export const output = {
  info: (message: string) => logger.info(message),
  warn: (message: string) => logger.warn(message),
  error: (message: string) => logger.error(message),
  success: (message: string) => logger.info(`✓ ${message}`),
  section: (title: string) => logger.info(`\n=== ${title} ===`),
  kv: (key: string, value: string | number) => logger.info(`  ${key}: ${value}`),
  list: (items: string[]) => items.forEach(item => logger.info(`  - ${item}`)),
  table: (rows: Record<string, any>[]) => console.table(rows),
};

/**
 * Format genome score for display
 */
export function formatGenomeScore(score: number): string {
  const pct = (score * 100).toFixed(1);
  let status = 'Poor';
  if (score >= 0.9) status = 'Excellent';
  else if (score >= 0.75) status = 'Good';
  else if (score >= 0.6) status = 'Fair';
  return `${pct}% — ${status}`;
}

/**
 * Format debt report for display
 */
export function formatDebtReport(report: { totalItems: number; bySeverity: Record<string, number>; coherenceGenomeScore: number; items: any[] }): string {
  const lines = [
    '=== Cognitive Debt Report ===',
    `Total items: ${report.totalItems}`,
    `High: ${report.bySeverity.high}`,
    `Medium: ${report.bySeverity.medium}`,
    `Low: ${report.bySeverity.low}`,
    `Genome score: ${formatGenomeScore(report.coherenceGenomeScore)}`,
  ];
  
  if (report.items.length > 0) {
    lines.push('\nDebt items:');
    for (const item of report.items) {
      lines.push(`\n[${item.severity.toUpperCase()}] ${item.type}`);
      lines.push(`  ${item.description}`);
      lines.push(`  File: ${item.filePath || 'project-wide'}`);
      if (item.suggestion) lines.push(`  Suggestion: ${item.suggestion}`);
    }
  } else {
    lines.push('\nNo cognitive debt found.');
  }
  
  return lines.join('\n');
}

/**
 * Standard error handler for CLI commands
 */
export function handleCliError(error: unknown, context?: string): never {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`${context ? `${context}: ` : ''}${message}`);
  if (error instanceof Error && error.stack) {
    logger.debug(error.stack);
  }
  process.exit(1);
}

/**
 * Async handler wrapper for Commander commands
 */
export function asyncHandler<T extends (...args: any[]) => Promise<any>>(
  fn: T
): (...args: Parameters<T>) => Promise<void> {
  return async (...args: Parameters<T>) => {
    try {
      await fn(...args);
      process.exit(0);
    } catch (error) {
      handleCliError(error);
    }
  };
}

/**
 * Helper to get files to check (supports single file or directory)
 */
export async function getFilesToCheck(path: string): Promise<string[]> {
  const fg = await import('fast-glob');
  const glob = fg.default ?? fg;
  
  if (existsSync(path) && statSync(path).isFile()) {
    return [path];
  }
  return glob([`${path}/**/*.{ts,js,tsx,jsx}`], {
    ignore: ['node_modules/**', 'dist/**'],
    absolute: true,
  });
}

/**
 * Base class for CLI commands to eliminate boilerplate
 */
export abstract class BaseCommand {
  protected cmd: Command;
  
  constructor(name: string, description: string) {
    this.cmd = new Command(name).description(description);
  }
  
  protected withContext<T>(fn: (ctx: CLIContext) => Promise<T>): Promise<T> {
    return withContext(fn);
  }
  
  protected withScale(fn: ContextFn<any>): Promise<void> {
    return withScale(fn);
  }
  
  protected withDebt(fn: ContextFn<any>): Promise<void> {
    return withDebt(fn);
  }
  
  protected withCoherence(fn: ContextFn<any>): Promise<void> {
    return withCoherence(fn);
  }
  
  protected withServices(
    services: ('scale' | 'debt' | 'coherence')[],
    fn: (ctx: CLIContext, services: Record<string, any>) => Promise<void>
  ): Promise<void> {
    return withServices(services, fn);
  }
  
  protected output = output;
  protected formatGenomeScore = formatGenomeScore;
  protected handleError = handleCliError;
  protected getFilesToCheck = getFilesToCheck;
  
  getCommand(): Command {
    return this.cmd;
  }
}

/**
 * Retry utility for transient failures
 */
export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableErrors?: string[];
  onRetry?: (attempt: number, error: Error) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 10000,
    backoffMultiplier = 2,
    retryableErrors = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'timeout', 'network'],
    onRetry,
  } = options;

  let lastError: Error;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      const isRetryable = retryableErrors.some(e => 
        lastError.message.includes(e) || lastError.name.includes(e)
      );
      
      if (!isRetryable || attempt === maxAttempts) {
        throw lastError;
      }
      
      const delay = Math.min(
        baseDelayMs * Math.pow(backoffMultiplier, attempt - 1),
        maxDelayMs
      );
      
      if (onRetry) {
        onRetry(attempt, lastError);
      } else {
        logger.warn(`Attempt ${attempt}/${maxAttempts} failed: ${lastError.message}. Retrying in ${delay}ms...`);
      }
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError!;
}

/**
 * Debug/Profiling utilities
 */
export const debug = {
  enabled: process.env.DEBUG === '1' || process.env.PROJECTMIND_DEBUG === '1',
  
  log: (label: string, data: any) => {
    if (debug.enabled) {
      logger.debug(`[DEBUG] ${label}:`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
    }
  },
  
  time: (label: string) => {
    if (debug.enabled) {
      console.time(`[PROFILE] ${label}`);
    }
  },
  
  timeEnd: (label: string) => {
    if (debug.enabled) {
      console.timeEnd(`[PROFILE] ${label}`);
    }
  },
  
  profile: async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    if (debug.enabled) {
      debug.time(label);
      try {
        return await fn();
      } finally {
        debug.timeEnd(label);
      }
    }
    return fn();
  },
};

/**
 * Agent coverage tracking helper
 */
export function trackAgentTouched(kg: KnowledgeGraph, filePath: string, agentName: string): void {
  kg.markAgentTouched(filePath, agentName);
}