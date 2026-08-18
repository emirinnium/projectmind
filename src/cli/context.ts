import { loadConfig } from '../utils/config.js';
import { initDatabase, closeDatabase } from '../storage/database.js';
import { SCHEMA_SQL } from '../storage/schema.js';
import { KnowledgeGraph } from '../storage/knowledge-graph.js';
import { ScaleManager } from '../core/scale-manager.js';
import { CoherenceEngine } from '../core/coherence-engine.js';
import { DebtTracker } from '../core/debt-tracker.js';
import { PatternLibrary } from '../parser/pattern-extractor.js';
import { createLLMProvider } from '../core/llm-providers.js';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import fg from 'fast-glob';

/**
 * CLI Context - provides shared services for all CLI commands
 * Eliminates boilerplate duplication across command modules
 */
export class CliContext {
  private config = loadConfig();
  private _db: ReturnType<typeof initDatabase> | null = null;
  private _kg: KnowledgeGraph | null = null;
  private _scale: ScaleManager | null = null;
  private _coherence: CoherenceEngine | null = null;
  private _debt: DebtTracker | null = null;
  private _patterns: PatternLibrary | null = null;

  getConfig() {
    return this.config;
  }

  getDb() {
    if (!this._db) {
      const dbPath = join(this.config.projectRoot, this.config.databasePath);
      const dbDir = dirname(dbPath);
      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
      }
      this._db = initDatabase(dbPath);
      this._db.exec(SCHEMA_SQL);
    }
    return this._db;
  }

  getKnowledgeGraph(): KnowledgeGraph {
    if (!this._kg) {
      this._kg = new KnowledgeGraph(this.getDb());
    }
    return this._kg;
  }

  getScaleManager(): ScaleManager {
    if (!this._scale) {
      this._scale = new ScaleManager(this.getDb(), this.getKnowledgeGraph());
    }
    return this._scale;
  }

  getCoherenceEngine(): CoherenceEngine {
    if (!this._coherence) {
      this._coherence = new CoherenceEngine(this.getDb());
      // Try to set up LLM provider
      const llmConfig = {
        provider: this.config.llm.provider,
        model: this.config.llm.model,
        apiKey: this.config.llm.apiKey,
        deepModel: this.config.llm.deepModel,
      };
      const llmProvider = createLLMProvider(llmConfig);
      if (llmProvider) {
        this._coherence.setLLMProvider(llmProvider);
      }
    }
    return this._coherence;
  }

  getDebtTracker(): DebtTracker {
    if (!this._debt) {
      this._debt = new DebtTracker(
        this.getDb(),
        this.getKnowledgeGraph(),
        this.getCoherenceEngine()
      );
    }
    return this._debt;
  }

  getPatternLibrary(): PatternLibrary {
    if (!this._patterns) {
      this._patterns = new PatternLibrary(this.getDb());
    }
    return this._patterns;
  }

  async ensureDatabase(): Promise<void> {
    this.getDb(); // Initialize
  }

  close(): void {
    closeDatabase();
    this._db = null;
    this._kg = null;
    this._scale = null;
    this._coherence = null;
    this._debt = null;
    this._patterns = null;
  }
}

/**
 * Create a CLI context instance
 */
export function createCliContext(): CliContext {
  return new CliContext();
}

/**
 * Common command options and helpers
 */
export interface CommandOptions {
  root?: string;
  deep?: boolean;
}

export function getProjectRoot(options: CommandOptions): string {
  return options.root ?? process.cwd();
}

export async function getFilesToCheck(path: string): Promise<string[]> {
  const fs = await import('node:fs');
  if (fs.existsSync(path) && fs.statSync(path).isFile()) {
    return [path];
  }
  return fg([`${path}/**/*.{ts,js,tsx,jsx}`], {
    ignore: ['node_modules/**', 'dist/**'],
    absolute: true,
  });
}

/**
 * Standard database setup for commands that need it
 * @deprecated Use withContext from ../utils/shared.js instead
 */
export async function withDatabase<T>(fn: (ctx: CliContext) => Promise<T>): Promise<T> {
  const ctx = createCliContext();
  try {
    await ctx.ensureDatabase();
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

/**
 * Standard database setup with scale manager
 * @deprecated Use withScale from ../utils/shared.js instead
 */
export async function withScale<T>(fn: (ctx: CliContext, scale: ScaleManager) => Promise<T>): Promise<T> {
  return withDatabase(async (ctx) => {
    return fn(ctx, ctx.getScaleManager());
  });
}

/**
 * Standard database setup with coherence engine
 * @deprecated Use withCoherence from ../utils/shared.js instead
 */
export async function withCoherence<T>(fn: (ctx: CliContext, coherence: CoherenceEngine) => Promise<T>): Promise<T> {
  return withDatabase(async (ctx) => {
    return fn(ctx, ctx.getCoherenceEngine());
  });
}

/**
 * Standard database setup with debt tracker
 * @deprecated Use withDebt from ../utils/shared.js instead
 */
export async function withDebt<T>(fn: (ctx: CliContext, debt: DebtTracker) => Promise<T>): Promise<T> {
  return withDatabase(async (ctx) => {
    return fn(ctx, ctx.getDebtTracker());
  });
}

/**
 * Standard database setup with pattern library
 * @deprecated Use withPatterns from ../utils/shared.js instead
 */
export async function withPatterns<T>(fn: (ctx: CliContext, patterns: PatternLibrary) => Promise<T>): Promise<T> {
  return withDatabase(async (ctx) => {
    return fn(ctx, ctx.getPatternLibrary());
  });
}

// Re-export new shared utilities for migration
export { 
  withContext, 
  withScale as withScaleNew, 
  withDebt as withDebtNew, 
  withCoherence as withCoherenceNew,
  withServices,
  asyncHandler,
  output,
  formatGenomeScore,
  formatDebtReport,
  handleCliError
} from './utils/shared.js';