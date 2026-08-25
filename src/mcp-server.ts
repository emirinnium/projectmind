import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAllTools } from './mcp/tools/registry/index.js';
import { registerCoreResources, registerWorkflowPrompts } from './mcp/resources.js';
import { logger } from './cli/utils/logger.js';
import { initializeDependencies, getDependencies } from './mcp/dependencies.js';
import { closeDatabase } from './storage/database.js';
import { resolvePackageVersion, currentModuleDir } from './utils/version.js';
import { pathToFileURL } from 'node:url';

let _server: McpServer | null = null;
let _httpServer: http.Server | null = null;
let _initialized = false;

async function ensureInitialized(): Promise<void> {
  if (_initialized) return;
  await initializeDependencies();
  _initialized = true;
}

/** Max request body accepted on the stateless HTTP endpoint (10 MB). */
const HTTP_MAX_BODY = 10 * 1024 * 1024;

export async function initMcpServer(): Promise<void> {
  try {
    await ensureInitialized();

    const server = new McpServer({
      name: 'projectmind',
      // Real package version (was hardcoded '1.0.0' while package.json said 0.2.x).
      version: resolvePackageVersion(currentModuleDir(import.meta.url)) || '0.0.0',
    });

    await registerAllTools(server, getDependencies());

    // Contextual data + reusable agent workflows (resources/read, prompts/get).
    try {
      registerCoreResources(server, getDependencies());
      registerWorkflowPrompts(server);
      logger.info('ProjectMind resources (pm://schema, pm://config, pm://stats) and workflow prompts registered.');
    } catch (e) {
      logger.warn('Resource/prompt registration failed (continuing without them):', { error: e });
    }

    _server = server;

    // Optional stateless Streamable HTTP endpoint for remote / team-shared
    // deployments: PROJECTMIND_HTTP_PORT=8787 pm mcp  → POST http://127.0.0.1:8787/mcp
    const httpPort = parseInt(process.env.PROJECTMIND_HTTP_PORT ?? '', 10);
    if (Number.isFinite(httpPort) && httpPort > 0) {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);

      const httpServer = http.createServer((req, res) => {
        void (async () => {
          try {
            if (req.method !== 'POST' || req.url !== '/mcp') {
              res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Stateless MCP endpoint: POST /mcp only.' }));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req) {
              size += (chunk as Buffer).length;
              if (size > HTTP_MAX_BODY) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Payload too large' }));
                return;
              }
              chunks.push(chunk as Buffer);
            }
            const bodyText = Buffer.concat(chunks).toString('utf-8');
            let body: unknown;
            try {
              body = JSON.parse(bodyText);
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON body' }));
              return;
            }
            await transport.handleRequest(req, res, body);
          } catch (e) {
            logger.error('HTTP transport error', { error: e });
            if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal error' }));
          }
        })();
      });

      await new Promise<void>((resolve) => httpServer.listen(httpPort, '127.0.0.1', resolve));
      _httpServer = httpServer;
      logger.info(`ProjectMind MCP HTTP (stateless) listening on http://127.0.0.1:${httpPort}/mcp`);
      return; // HTTP mode keeps the process alive via the http server.
    }

    const transport = new StdioServerTransport();
    logger.info('ProjectMind MCP Server starting...');
    await server.connect(transport);
    logger.info('ProjectMind MCP Server ready.');
  } catch (e) {
    logger.error('Failed to initialize MCP server:', { error: e });
    throw e;
  }
}

export async function shutdownMcpServer(): Promise<void> {
  if (_httpServer) {
    await new Promise<void>((resolve) => _httpServer!.close(() => resolve()));
    _httpServer = null;
  }
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

// Main-module detection hardened: process.argv[1] is undefined under
// `node -e` / embedded ESM evaluation, and Windows paths need file:// URLs.
const isMainModule = (() => {
  try {
    const arg1 = process.argv[1];
    if (!arg1) return false;
    return import.meta.url === pathToFileURL(arg1).href;
  } catch {
    return false;
  }
})();
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
