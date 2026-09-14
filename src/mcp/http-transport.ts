import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import http from 'node:http';
import { handleOauthRoute } from '../auth/http.js';
import { logger } from '../cli/utils/logger.js';
import { getDependencies } from './dependencies.js';
import {
  HTTP_AUTH_TOKEN,
  HTTP_MAX_BODY,
  HTTP_RATE_LIMIT_PER_MIN,
  MCP_ACCESS_SCOPE,
  OAUTH_ENABLED,
  OAUTH_TOKEN_TTL,
  assertHttpBindingSecurity,
  getOauthRegistry,
  getOauthTokens,
  httpRateLimiter,
  isHttpAuthorized,
  isStaticTokenValid,
  jsonError,
} from './http-security.js';
import { MetaValidationError, validateRequestMeta } from './tools/types.js';

function setAgentIdentity(server: McpServer): void {
  try {
    const deps = getDependencies();
    deps.agentName =
      process.env.PROJECTMIND_AGENT_NAME ||
      server.server.getClientVersion?.()?.name ||
      'mcp-client';
  } catch (error) {
    // Client metadata is optional during transport startup. Keep the safe
    // fallback, but retain a diagnostic for debug-level investigations.
    logger.debug('MCP client metadata unavailable; using fallback agent identity.', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readRequestBody(req: http.IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > HTTP_MAX_BODY) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function createRequestHandler(transport: StreamableHTTPServerTransport): http.RequestListener {
  return (req, res) => {
    void (async () => {
      try {
        const requestPath = normalizeRequestPath(req.url);
        if (req.method !== 'POST' || requestPath === null || !isKnownRoute(requestPath)) {
          jsonError(
            res,
            405,
            {
              error: 'Stateless MCP endpoint: POST /mcp, /oauth/register or /oauth/token only.',
            },
            { Allow: 'POST' },
          );
          return;
        }

        // Per-IP sliding-window rate limit (applies to every endpoint).
        const ip = req.socket.remoteAddress || 'unknown';
        const rl = httpRateLimiter.check(ip);
        if (!rl.ok) {
          jsonError(
            res,
            429,
            { error: `Rate limit exceeded (${HTTP_RATE_LIMIT_PER_MIN} req/min).` },
            { 'Retry-After': String(rl.retryAfterSec) },
          );
          return;
        }

        const bodyText = await readRequestBody(req);
        if (bodyText === null) {
          jsonError(res, 413, { error: 'Payload too large' });
          return;
        }

        // OAuth 2.0 DCR (RFC 7591) + client-credentials token endpoint.
        if (requestPath === '/oauth/register' || requestPath === '/oauth/token') {
          if (!OAUTH_ENABLED) {
            jsonError(res, 404, {
              error: 'OAuth endpoints are disabled (set PROJECTMIND_OAUTH_ENABLED=1).',
            });
            return;
          }
          // /oauth/register is itself a protected resource (RFC 7591 §2.1):
          // require the static admin token when one is configured.
          // /oauth/token is NOT protected — it is the auth step.
          if (requestPath === '/oauth/register' && HTTP_AUTH_TOKEN && !isStaticTokenValid(req)) {
            jsonError(
              res,
              401,
              {
                error: 'Unauthorized: /oauth/register requires the static PROJECTMIND_HTTP_TOKEN.',
              },
              { 'WWW-Authenticate': 'Bearer' },
            );
            return;
          }
          const result = handleOauthRoute(
            requestPath,
            bodyText,
            req.headers['content-type'] ?? '',
            {
              registry: getOauthRegistry(),
              tokens: getOauthTokens(),
              authorization: req.headers.authorization,
              allowedScopes: [MCP_ACCESS_SCOPE],
            },
          );
          if (!result.handled) {
            jsonError(res, 500, { error: 'OAuth route failed' });
            return;
          }
          res.writeHead(result.status, {
            'Content-Type': 'application/json',
            ...result.headers,
          });
          res.end(JSON.stringify(result.payload));
          return;
        }

        // /mcp — auth (static token and/or OAuth bearer), then transport.
        // The authorization helper returns a strict boolean so invalid
        // credentials cannot be treated as a truthy error object.
        if (!isHttpAuthorized(req)) {
          jsonError(
            res,
            401,
            { error: 'Unauthorized: missing or invalid token.' },
            { 'WWW-Authenticate': 'Bearer' },
          );
          return;
        }

        let body: Record<string, unknown>;
        try {
          body = JSON.parse(bodyText) as Record<string, unknown>;
        } catch (error) {
          logger.debug('MCP HTTP request body was not valid JSON.', {
            error: error instanceof Error ? error.message : String(error),
          });
          jsonError(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        // Validate _meta envelope if present (malformed envelope rejected).
        try {
          validateRequestMeta(body);
        } catch (error) {
          if (error instanceof MetaValidationError) {
            jsonError(res, 400, { error: `Invalid _meta: ${error.message}` });
            return;
          }
          throw error;
        }
        await transport.handleRequest(req, res, body);
      } catch (error) {
        logger.error('HTTP transport error', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
    })();
  };
}

/** Start the optional stateless HTTP transport and return its server handle. */
export async function startHttpMcpTransport(server: McpServer, port: number): Promise<http.Server> {
  const httpHost = process.env.PROJECTMIND_HTTP_HOST ?? '127.0.0.1';
  assertHttpBindingSecurity(httpHost);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  setAgentIdentity(server);

  const httpServer = http.createServer(createRequestHandler(transport));
  await new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      httpServer.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      httpServer.off('listening', onListening);
      reject(error);
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(port, httpHost);
  });

  logger.info(
    `ProjectMind MCP HTTP (stateless) listening on http://${httpHost}:${port}/mcp (rate limit: ${HTTP_RATE_LIMIT_PER_MIN} req/min/IP${OAUTH_ENABLED ? ', OAuth DCR enabled' : ''})`,
  );
  if (OAUTH_ENABLED) {
    logger.info(
      `OAuth 2.0 DCR ready — POST /oauth/register (RFC 7591), POST /oauth/token (client_credentials); access-token TTL ${OAUTH_TOKEN_TTL}s.`,
    );
  }
  if (!HTTP_AUTH_TOKEN && !OAUTH_ENABLED) {
    logger.warn('MCP HTTP endpoint is unauthenticated but restricted to loopback.');
  }
  return httpServer;
}

/** Return a canonical route path while accepting query strings and one slash. */
export function normalizeRequestPath(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const pathname = new URL(rawUrl, 'http://projectmind.local').pathname;
    return pathname.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

function isKnownRoute(pathname: string): boolean {
  return pathname === '/mcp' || pathname === '/oauth/register' || pathname === '/oauth/token';
}
