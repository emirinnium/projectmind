import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './mcp/tools/registry/index.js';
import { logger } from './cli/utils/logger.js';
import { initializeDependencies, getDependencies } from './mcp/dependencies.js';
import { closeDatabase } from './storage/database.js';
import { resolvePackageVersion, currentModuleDir } from './utils/version.js';

let _server: McpServer | null = null;
let _initialized = false;

async function ensureInitialized(): Promise<void> {
  if (_initialized) return;
  await initializeDependencies();
  _initialized = true;
}

export async function initMcpServer(): Promise<void> {
  try {
    await ensureInitialized();

    const server = new McpServer({
      name: 'projectmind',
      // Real package version (was hardcoded '1.0.0' while package.json said 0.2.x).
      version: resolvePackageVersion(currentModuleDir(import.meta.url)) || '0.0.0',
    });

    registerAllTools(server, getDependencies());

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
  if (_initialized) {
    const deps = getDependencies();
    const sessions = deps.kg.getAgentSessions('mcp-client', 1);
    if (sessions.length > 0) {
      deps.kg.endAgentSession(sessions[0].id);
      logger.info(`MCP agent session ended: ${sessions[0].id}`);
    }
    closeDatabase();
    _initialized = false;
  }
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
