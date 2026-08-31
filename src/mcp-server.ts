import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { handleOauthRoute } from './auth/http.js';
import { logger } from './cli/utils/logger.js';
import { initializeDependencies, getDependencies, getMcpSessionId } from './mcp/dependencies.js';
import { registerCoreResources, registerWorkflowPrompts, registerResourceSubscriptionTool } from './mcp/resources.js';
import { stopPeriodicCleanup } from './mcp/tools/locks.js';
import { registerAllTools } from './mcp/tools/registry/index.js';
import { closeAllLiveWatchers } from './mcp/tools/sync.js';
import { validateRequestMeta, MetaValidationError } from './mcp/tools/types.js';
import { closeDatabase } from './storage/database.js';
import { resolvePackageVersion, currentModuleDir } from './utils/version.js';
import {
  HTTP_MAX_BODY,
  HTTP_AUTH_TOKEN,
  HTTP_RATE_LIMIT_PER_MIN,
  OAUTH_ENABLED,
  OAUTH_TOKEN_TTL,
  MCP_ACCESS_SCOPE,
  getOauthRegistry,
  getOauthTokens,
  extractBearerOrHeaderToken,
  isStaticTokenValid,
  isHttpAuthorized,
  safeTokenEqual,
  httpRateLimiter,
  jsonError,
} from './mcp/http-security.js';

let _server: McpServer | null = null;
let _httpServer: http.Server | null = null;
let _initialized = false;
let _signalHandlersRegistered = false;

/**
 * Register graceful-shutdown signal handlers on the SERVER STARTUP path only.
 * Importing this module as a library (src/index.ts re-exports it) must never
 * touch process signals; only an actual server start does. Guarded so repeated
 * initMcpServer() calls never register duplicate handlers.
 */
function registerSignalHandlers(): void {
  if (_signalHandlersRegistered) return;
  _signalHandlersRegistered = true;

  process.on('SIGINT', async () => {
    await shutdownMcpServer();
  });

  process.on('SIGTERM', async () => {
    await shutdownMcpServer();
  });
}

/**
 * Notify connected clients that the tool and resource lists have changed.
 *
 * Uses the MCP SDK's built-in `sendToolListChanged` / `sendResourceListChanged`.
 * The SDK only delivers these while a transport is connected (it no-ops
 * otherwise), so calling this at startup before `server.connect()` is safe.
 * The corresponding `listChanged: true` capability is advertised automatically
 * by the SDK the moment tools / resources are registered.
 */
async function sendListChangedNotification(): Promise<void> {
  if (!_server || !_server.isConnected()) return;
  try {
    _server.sendToolListChanged();
  } catch (e) {
    logger.warn('Failed to send tools/listChanged notification', { error: e instanceof Error ? e.message : String(e) });
  }
  try {
    _server.sendResourceListChanged();
  } catch (e) {
    logger.warn('Failed to send resources/listChanged notification', { error: e instanceof Error ? e.message : String(e) });
  }
}

async function ensureInitialized(): Promise<void> {
  if (_initialized) return;
  await initializeDependencies();
  _initialized = true;
}

export async function initMcpServer(): Promise<void> {
  // Server startup path: arm graceful shutdown handlers (never at import time).
  registerSignalHandlers();

  try {
    await ensureInitialized();

    const server = new McpServer({
      name: 'projectmind',
      // Real package version (was hardcoded '1.0.0' while package.json said 0.2.x).
      version: resolvePackageVersion(currentModuleDir(import.meta.url)) || '0.0.0',
    });

    await registerAllTools(server, getDependencies());
    await sendListChangedNotification();

    // Contextual data + reusable agent workflows (resources/read, prompts/get).
    // Registration is retried once after a short delay — transient init
    // ordering issues should not permanently cost the client its resources.
    const registerContextualSurface = async (): Promise<void> => {
      registerCoreResources(server, getDependencies());
      registerWorkflowPrompts(server);
      registerResourceSubscriptionTool(server);
    };
    try {
      await registerContextualSurface();
      logger.info('ProjectMind resources (pm://schema, pm://config, pm://stats) and workflow prompts registered.');
      await sendListChangedNotification();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`Resource/prompt registration failed (${msg}) — retrying once...`);
      await new Promise((r) => setTimeout(r, 250));
      try {
        await registerContextualSurface();
        logger.info('ProjectMind resources and workflow prompts registered (after retry).');
      } catch (e2) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        logger.error(`Resource/prompt registration failed after retry: ${msg2} — continuing without them.`);
      }
    }

    _server = server;

    // Optional stateless Streamable HTTP endpoint for remote / team-shared
    // deployments: PROJECTMIND_HTTP_PORT=8787 pm mcp  → POST http://127.0.0.1:8787/mcp
    const httpPort = parseInt(process.env.PROJECTMIND_HTTP_PORT ?? '', 10);
    if (Number.isFinite(httpPort) && httpPort > 0) {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      try {
        const deps = getDependencies();
        deps.agentName = process.env.PROJECTMIND_AGENT_NAME || server.server.getClientVersion?.()?.name || 'mcp-client';
      } catch {
        // client info unavailable — keep fallback
      }

      const httpServer = http.createServer((req, res) => {
        void (async () => {
          try {
            if (
              req.method !== 'POST' ||
              (req.url !== '/mcp' && req.url !== '/oauth/register' && req.url !== '/oauth/token')
            ) {
              jsonError(
                res,
                405,
                { error: 'Stateless MCP endpoint: POST /mcp, /oauth/register or /oauth/token only.' },
                { Allow: 'POST' },
              );
              return;
            }

            // Per-IP sliding-window rate limit (applies to every endpoint).
            const ip = req.socket.remoteAddress || 'unknown';
            const rl = httpRateLimiter.check(ip);
            if (!rl.ok) {
              jsonError(res, 429, { error: `Rate limit exceeded (${HTTP_RATE_LIMIT_PER_MIN} req/min).` }, { 'Retry-After': String(rl.retryAfterSec) });
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

            // OAuth 2.0 DCR (RFC 7591) + client-credentials token endpoint.
            if (req.url === '/oauth/register' || req.url === '/oauth/token') {
              if (!OAUTH_ENABLED) {
                jsonError(res, 404, { error: 'OAuth endpoints are disabled (set PROJECTMIND_OAUTH_ENABLED=1).' });
                return;
              }
              // /oauth/register is itself a protected resource (RFC 7591 §2.1):
              // require the static admin token when one is configured.
              // /oauth/token is NOT protected — it is the auth step.
              if (req.url === '/oauth/register' && !isStaticTokenValid(req)) {
                jsonError(
                  res,
                  401,
                  { error: 'Unauthorized: /oauth/register requires the static PROJECTMIND_HTTP_TOKEN.' },
                  { 'WWW-Authenticate': 'Bearer' },
                );
                return;
              }
              const result = handleOauthRoute(req.url, bodyText, req.headers['content-type'] ?? '', {
                registry: getOauthRegistry(),
                tokens: getOauthTokens(),
                authorization: req.headers['authorization'],
                allowedScopes: [MCP_ACCESS_SCOPE],
              });
              if (!result.handled) {
                jsonError(res, 500, { error: 'OAuth route failed' });
                return;
              }
              res.writeHead(result.status, { 'Content-Type': 'application/json', ...result.headers });
              res.end(JSON.stringify(result.payload));
              return;
            }

            // /mcp — auth (static token and/or OAuth bearer), then transport.
            if (!isHttpAuthorized(req)) {
              jsonError(res, 401, { error: 'Unauthorized: missing or invalid token.' }, { 'WWW-Authenticate': 'Bearer' });
              return;
            }

            let body: Record<string, unknown>;
            try {
              body = JSON.parse(bodyText);
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON body' }));
              return;
            }
            // Validate _meta envelope if present (malformed envelope rejected).
            try {
              validateRequestMeta(body);
            } catch (e) {
              if (e instanceof MetaValidationError) {
                jsonError(res, 400, { error: `Invalid _meta: ${e.message}` });
                return;
              }
              throw e;
            }
            await transport.handleRequest(req, res, body);
          } catch (e) {
            logger.error('HTTP transport error', { error: e instanceof Error ? e.message : String(e) });
            if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal error' }));
          }
        })();
      });

      await new Promise<void>((resolve) => httpServer.listen(httpPort, '127.0.0.1', resolve));
      _httpServer = httpServer;
      logger.info(
        `ProjectMind MCP HTTP (stateless) listening on http://127.0.0.1:${httpPort}/mcp (rate limit: ${HTTP_RATE_LIMIT_PER_MIN} req/min/IP${OAUTH_ENABLED ? ', OAuth DCR enabled' : ''})`,
      );
      if (OAUTH_ENABLED) {
        logger.info(
          `OAuth 2.0 DCR ready — POST /oauth/register (RFC 7591), POST /oauth/token (client_credentials); access-token TTL ${OAUTH_TOKEN_TTL}s.`,
        );
      }
      if (!HTTP_AUTH_TOKEN && !OAUTH_ENABLED) {
        logger.warn('PROJECTMIND_HTTP_TOKEN is NOT set — the endpoint is unauthenticated. It is bound to 127.0.0.1 only; set a token before exposing it beyond loopback.');
      }
      return; // HTTP mode keeps the process alive via the http server.
    }

    const transport = new StdioServerTransport();
    logger.info('ProjectMind MCP Server starting...');
    await server.connect(transport);
    try {
      const deps = getDependencies();
      deps.agentName = process.env.PROJECTMIND_AGENT_NAME || server.server.getClientVersion?.()?.name || 'mcp-client';
    } catch {
      // client info unavailable — keep fallback
    }
    logger.info('ProjectMind MCP Server ready.');
  } catch (e) {
    logger.error('Failed to initialize MCP server:', { error: e instanceof Error ? e.message : String(e) });
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
    // End EXACTLY the session this process opened (tracked at init) — the
    // previous "close latest mcp-client session" heuristic leaked sessions
    // when multiple server instances shared one database, and could close
    // another live instance's session.
    const ownSessionId = getMcpSessionId();
    if (ownSessionId !== null) {
      try {
        deps.kg.endAgentSession(ownSessionId);
        logger.info(`MCP agent session ended: ${ownSessionId}`);
      } catch (e) {
        logger.warn('Failed to end MCP agent session:', { error: e instanceof Error ? e.message : String(e) });
      }
    }
    try {
      stopPeriodicCleanup();
    } catch (e) {
      logger.warn('Failed to stop periodic cleanup:', { error: e instanceof Error ? e.message : String(e) });
    }
    try {
      closeAllLiveWatchers();
    } catch (e) {
      logger.warn('Failed to close live watchers:', { error: e instanceof Error ? e.message : String(e) });
    }
    closeDatabase();
    _initialized = false;
  }
}

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
      logger.error('Failed to start MCP server:', { error: e instanceof Error ? e.message : String(e) });
      process.exitCode = 1;
    }
  })();
}
