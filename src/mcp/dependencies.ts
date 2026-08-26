import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadConfig } from '../utils/config.js';
import { initDatabase, setDatabase } from '../storage/database.js';
import { SCHEMA_SQL } from '../storage/schema.js';
import { KnowledgeGraph } from '../storage/knowledge-graph.js';
import { CoherenceEngine } from '../core/coherence/engine.js';
import { DebtTracker } from '../core/debt/tracker.js';
import { ScaleManager } from '../core/scale/manager.js';
import { createLLMProvider } from '../core/llm/index.js';
import { logger } from '../cli/utils/logger.js';
import type { McpDependencies } from './tools/types.js';

let _db: DatabaseSync | null = null;
let _deps: McpDependencies | null = null;
/** Session row created by THIS server process (ended on graceful shutdown). */
let _mcpSessionId: number | null = null;

export function getDependencies(): McpDependencies {
  if (!_deps) throw new Error('Dependencies not initialized');
  return _deps;
}

/**
 * The agent-session id this server process opened at startup
 * ('mcp-client'). Graceful shutdown ends exactly this row instead of
 * "the latest mcp-client session", which leaked sessions when multiple
 * server instances shared one database.
 */
export function getMcpSessionId(): number | null {
  return _mcpSessionId;
}

export async function initializeDependencies(): Promise<McpDependencies> {
  if (_deps) return _deps;

  const config = loadConfig();
  const dbPath = join(config.projectRoot, config.databasePath);
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  _db = initDatabase(dbPath);
  _db.exec(SCHEMA_SQL);
  setDatabase(_db);

  const kg = new KnowledgeGraph(_db);
  const coherence = new CoherenceEngine(_db, config.llm.maxCacheSize, 300_000);
  const debt = new DebtTracker(_db, kg, coherence);
  const scale = new ScaleManager(_db, kg);

  const llmConfig = {
    provider: config.llm.provider,
    model: config.llm.model,
    apiKey: config.llm.apiKey,
    deepModel: config.llm.deepModel,
  };
  const llmProvider = createLLMProvider(llmConfig);
  if (llmProvider) {
    coherence.setLLMProvider(llmProvider);
  }

  const sessionId = kg.startAgentSession('mcp-client');
  _mcpSessionId = sessionId;
  logger.info(`MCP agent session started: ${sessionId}`);

  if (config.scanOnStartup !== false) {
    const files = kg.getAllFiles();
    if (files.length === 0) {
      logger.info('Database empty — running initial scan...');
      try {
        const result = await scale.scanProject(config.projectRoot);
        logger.info(`Initial scan complete: ${result.scanned} files, ${result.errors} errors`);
      } catch (e) {
        logger.warn('Initial scan failed:', { error: e });
      }
    }
  }

  _deps = { kg, coherence, debt, scale };
  return _deps;
}

export function getDatabase(): DatabaseSync {
  if (!_db) throw new Error('Database not initialized');
  return _db;
}

export { KnowledgeGraph, CoherenceEngine, DebtTracker, ScaleManager };
