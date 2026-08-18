import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadConfig } from './utils/config.js';
import { initDatabase, setDatabase, closeDatabase } from './storage/database.js';
import { SCHEMA_SQL } from './storage/schema.js';
import { KnowledgeGraph } from './storage/knowledge-graph.js';
import { CoherenceEngine } from './core/coherence-engine.js';
import { DebtTracker } from './core/debt-tracker.js';
import { ScaleManager } from './core/scale-manager.js';
import { createLLMProvider } from './core/llm-providers.js';
import {
  registerCheckCoherenceTool,
  registerGetContextTool,
  registerStoreMemoryTool,
  registerGetMemoryTool,
  registerDebtReportTool,
  registerScaleReportTool,
  registerGenomeScoreTool,
  registerScanProjectTool,
  registerStartSessionTool,
  registerEndSessionTool,
  registerTraceImportsTool,
  registerFindCircularDepsTool,
  registerResolveImportTool,
  registerGetDependentsTool,
  registerGetDependencyGraphTool,
  registerResolvePathTool,
  registerFindFileByImportTool,
  registerCheckArchitectureTool,
  registerAnalyzeImpactTool,
  registerSuggestRefactorTool,
  registerFileWatchTool,
  registerGetFileStatusTool,
  registerSyncContextTool,
  registerUnregisterFileWatchTool,
} from './mcp/tools/index.js';
import type { McpDependencies } from './mcp/tools/index.js';
import { logger } from './cli/utils/logger.js';

let _server: McpServer | null = null;
let _db: DatabaseSync | null = null;
let _kg: KnowledgeGraph | null = null;
let _coherence: CoherenceEngine | null = null;
let _debt: DebtTracker | null = null;
let _scale: ScaleManager | null = null;
let _initialized = false;

async function ensureInitialized(): Promise<void> {
  if (_initialized && _db) return;

  const config = loadConfig();
  const dbPath = join(config.projectRoot, config.databasePath);
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  _db = initDatabase(dbPath);
  _db.exec(SCHEMA_SQL);
  setDatabase(_db);

  _kg = new KnowledgeGraph(_db);
  _coherence = new CoherenceEngine(_db, config.llm.maxCacheSize, 300_000);
  _debt = new DebtTracker(_db, _kg, _coherence);
  _scale = new ScaleManager(_db, _kg);

  const llmConfig = {
    provider: config.llm.provider,
    model: config.llm.model,
    apiKey: config.llm.apiKey,
    deepModel: config.llm.deepModel,
  };
  const llmProvider = createLLMProvider(llmConfig);
  if (llmProvider) {
    _coherence.setLLMProvider(llmProvider);
  }

  // Start MCP agent session
  const sessionId = _kg.startAgentSession('mcp-client');
  logger.info(`MCP agent session started: ${sessionId}`);

  // Auto-scan if enabled and database is empty
  if (config.scanOnStartup !== false) {
    const files = _kg.getAllFiles();
    if (files.length === 0) {
      logger.info('Database empty — running initial scan...');
      try {
        const result = await _scale.scanProject(config.projectRoot);
        logger.info(`Initial scan complete: ${result.scanned} files, ${result.errors} errors`);
      } catch (e) {
        logger.warn('Initial scan failed:', { error: e });
      }
    }
  }

  _initialized = true;
}

const deps: McpDependencies = {
  get kg() { return _kg!; },
  get coherence() { return _coherence!; },
  get debt() { return _debt!; },
  get scale() { return _scale!; },
  get agentName() { return 'mcp-client'; },
};

export async function initMcpServer(): Promise<void> {
  try {
    await ensureInitialized();

    const server = new McpServer({
      name: 'projectmind',
      version: '1.0.0',
    });

    // Core tools
    registerCheckCoherenceTool(server, deps);
    registerGetContextTool(server, deps);
    registerStoreMemoryTool(server, deps);
    registerGetMemoryTool(server, deps);
    registerDebtReportTool(server, deps);
    registerScaleReportTool(server, deps);
    registerGenomeScoreTool(server, deps);
    registerScanProjectTool(server, deps);
    registerStartSessionTool(server, deps);
    registerEndSessionTool(server, deps);

    // Import/Dependency analysis tools
    registerTraceImportsTool(server, deps);
    registerFindCircularDepsTool(server, deps);
    registerResolveImportTool(server, deps);
    registerGetDependentsTool(server, deps);
    registerGetDependencyGraphTool(server, deps);

    // Path resolution tools
    registerResolvePathTool(server, deps);
    registerFindFileByImportTool(server, deps);

    // Architecture/Impact analysis tools
    registerCheckArchitectureTool(server, deps);
    registerAnalyzeImpactTool(server, deps);
    registerSuggestRefactorTool(server, deps);

    // Continuous sync tools
    registerFileWatchTool(server, deps);
    registerGetFileStatusTool(server, deps);
    registerSyncContextTool(server, deps);
    registerUnregisterFileWatchTool(server, deps);

    const transport = new StdioServerTransport();
    _server = server;

    logger.info('ProjectMind MCP Server starting...');
    await server.connect(transport);
    logger.info('ProjectMind MCP Server ready.');
  } catch (e) {
    logger.error('Failed to initialize MCP server:', { error: e });
    throw e;
  }
}

export async function shutdownMcpServer(): Promise<void> {
  if (_server) {
    await _server.close();
    _server = null;
  }
  // End MCP agent session
  if (_kg) {
    const sessions = _kg.getAgentSessions('mcp-client', 1);
    if (sessions.length > 0) {
      _kg.endAgentSession(sessions[0].id);
      logger.info(`MCP agent session ended: ${sessions[0].id}`);
    }
  }
  if (_db) {
    closeDatabase();
    _db = null;
  }
  _kg = null;
  _coherence = null;
  _debt = null;
  _scale = null;
}

process.on('SIGINT', async () => {
  await shutdownMcpServer();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await shutdownMcpServer();
  process.exit(0);
});

const isMainModule = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || 
  import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`;
if (isMainModule) {
  logger.info('ProjectMind MCP Server: detected as main module, starting...');
  
  (async () => {
    try {
      await initMcpServer();
      process.stdin.resume();
    } catch (e) {
      logger.error('Failed to start MCP server:', { error: e });
      process.exit(1);
    }
  })();
}