import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAllTools } from './mcp/tools/registry/index.js';
import { registerCoreResources, registerWorkflowPrompts } from './mcp/resources.js';
import { logger } from './cli/utils/logger.js';
import { initializeDependencies, getDependencies, getMcpSessionId } from './mcp/dependencies.js';
import { closeDatabase } from './storage/database.js';
import { resolvePackageVersion, currentModuleDir } from './utils/version.js';
import { pathToFileURL } from 'node:url';
import { registerResourceSubscriptionTool } from './mcp/resources.js';
import { validateRequestMeta, MetaValidationError } from './mcp/tools/types.js';
import { ClientRegistry } from './auth/registry.js';
import { TokenService } from './auth/tokens.js';
import { handleOauthRoute } from './auth/http.js';

let _server: McpServer | null = null;
let _httpServer: http.Server | null = null;
let _initialized = false;

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

/** Max request body accepted on the stateless HTTP endpoint (10 MB). */
const HTTP_MAX_BODY = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// HTTP endpoint security (opt-in auth + per-IP rate limiting)
//
// PROJECTMIND_HTTP_TOKEN  — when set, every request must present the token
//                           via `Authorization: Bearer <token>` or
//                           `x-projectmind-token: <token>`.
// PROJECTMIND_HTTP_RATE_LIMIT — max requests/min/IP (default 120).
// ---------------------------------------------------------------------------

const HTTP_AUTH_TOKEN = process.env.PROJECTMIND_HTTP_TOKEN?.trim() || '';
const HTTP_RATE_LIMIT_PER_MIN = Math.max(1, parseInt(process.env.PROJECTMIND_HTTP_RATE_LIMIT ?? '120', 10) || 120);

// ---------------------------------------------------------------------------
// OAuth 2.0 Dynamic Client Registration (RFC 7591) + client-credentials flow.
//
// PROJECTMIND_OAUTH_ENABLED=1 — exposes POST /oauth/register (DCR) and
//   POST /oauth/token (RFC 6749 §4.4). Access tokens issued there are accepted
//   by /mcp as an alternative to the static PROJECTMIND_HTTP_TOKEN.
// PROJECTMIND_OAUTH_TOKEN_TTL  — access-token lifetime in seconds (default 3600).
//
// When PROJECTMIND_HTTP_TOKEN is set, /oauth/register additionally requires it
// (the registration endpoint is itself a protected resource per RFC 7591 §2.1);
// /oauth/token is deliberately open — it IS the credential-authenticating step.
// Enabling OAuth while no static token is configured turns /mcp into
// token-required mode (open loopback mode only when BOTH are off).
// ---------------------------------------------------------------------------

const OAUTH_ENABLED =
  process.env.PROJECTMIND_OAUTH_ENABLED === '1' || process.env.PROJECTMIND_OAUTH_ENABLED === 'true';
const OAUTH_TOKEN_TTL = Math.max(1, parseInt(process.env.PROJECTMIND_OAUTH_TOKEN_TTL ?? '3600', 10) || 3600);
const oauthRegistry = new ClientRegistry();
const oauthTokens = new TokenService(OAUTH_TOKEN_TTL);

/** Length-safe, timing-attack-resistant string comparison. */
function safeTokenEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Burn comparable time so response latency does not leak token length.
    try { timingSafeEqual(ab, ab); } catch { /* unreachable for equal buffers */ }
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function extractBearerOrHeaderToken(req: http.IncomingMessage): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const alt = req.headers['x-projectmind-token'];
  if (typeof alt === 'string') return alt.trim();
  return undefined;
}

/** Static-token check only (used by /mcp auth and the protected /oauth/register). */
function isStaticTokenValid(req: http.IncomingMessage): boolean {
  const presented = extractBearerOrHeaderToken(req);
  return presented !== undefined && presented.length > 0 && safeTokenEqual(presented, HTTP_AUTH_TOKEN);
}

function isHttpAuthorized(req: http.IncomingMessage): boolean {
  // Static bearer (admin) token wins when configured.
  if (HTTP_AUTH_TOKEN && isStaticTokenValid(req)) return true;
  // Dual mode: a valid OAuth access token also authorizes /mcp.
  if (OAUTH_ENABLED) {
    const presented = extractBearerOrHeaderToken(req);
    if (presented !== undefined && presented.length > 0 && oauthTokens.verify(presented) !== null) return true;
  }
  // Open loopback mode ONLY when no authentication is configured at all.
  if (!HTTP_AUTH_TOKEN && !OAUTH_ENABLED) return true;
  return false;
}

/** Sliding-window per-IP rate limiter (60s window). */
class HttpRateLimiter {
  private hits = new Map<string, number[]>();

  check(key: string, now = Date.now()): { ok: boolean; retryAfterSec: number } {
    const windowStart = now - 60_000;
    const list = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    if (list.length >= HTTP_RATE_LIMIT_PER_MIN) {
      this.hits.set(key, list);
      const retryAfterSec = Math.max(1, Math.ceil((list[0] + 60_000 - now) / 1000));
      return { ok: false, retryAfterSec };
    }
    list.push(now);
    this.hits.set(key, list);
    // Opportunistic GC so abandoned IPs cannot grow the map unbounded.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) {
        if (v.every((t) => t <= windowStart)) this.hits.delete(k);
      }
    }
    return { ok: true, retryAfterSec: 0 };
  }
}

const httpRateLimiter = new HttpRateLimiter();

function jsonError(res: http.ServerResponse, status: number, payload: Record<string, string | number | boolean | null>, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(payload));
}

export async function initMcpServer(): Promise<void> {
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
                registry: oauthRegistry,
                tokens: oauthTokens,
                authorization: req.headers['authorization'],
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
      logger.error('Failed to start MCP server:', { error: e instanceof Error ? e.message : String(e) });
      process.exit(1);
    }
  })();
}
