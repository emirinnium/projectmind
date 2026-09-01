/**
 * HTTP endpoint security layer for the MCP server.
 *
 * Centralizes all HTTP/OAuth security concerns: authentication (static token
 * + OAuth 2.0 DCR/client-credentials), per-IP rate limiting, and JSON error
 * responses. Extracted from mcp-server.ts to keep that file focused on
 * server lifecycle (init/shutdown) and below the 400-line cognitive threshold.
 *
 * Environment variables:
 *   PROJECTMIND_HTTP_TOKEN         — static bearer token for /mcp
 *   PROJECTMIND_HTTP_RATE_LIMIT    — max requests/min/IP (default 120)
 *   PROJECTMIND_OAUTH_ENABLED      — enable OAuth 2.0 (1/true)
 *   PROJECTMIND_OAUTH_TOKEN_TTL    — access-token lifetime in seconds (default 3600)
 */

import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { ClientRegistry } from '../auth/registry.js';
import { TokenService } from '../auth/tokens.js';
import { getDatabase } from '../storage/database.js';

/** Max request body accepted on the stateless HTTP endpoint (10 MB). */
export const HTTP_MAX_BODY = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// HTTP endpoint security (opt-in auth + per-IP rate limiting)
//
// PROJECTMIND_HTTP_TOKEN  — when set, every request must present the token
//                           via `Authorization: Bearer <token>` or
//                           `x-projectmind-token: <token>`.
// PROJECTMIND_HTTP_RATE_LIMIT — max requests/min/IP (default 120).
// ---------------------------------------------------------------------------

export const HTTP_AUTH_TOKEN = process.env.PROJECTMIND_HTTP_TOKEN?.trim() || '';
export const HTTP_RATE_LIMIT_PER_MIN = Math.max(
  1,
  parseInt(process.env.PROJECTMIND_HTTP_RATE_LIMIT ?? '120', 10) || 120,
);

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

export const OAUTH_ENABLED =
  process.env.PROJECTMIND_OAUTH_ENABLED === '1' || process.env.PROJECTMIND_OAUTH_ENABLED === 'true';
export const OAUTH_TOKEN_TTL = Math.max(
  1,
  parseInt(process.env.PROJECTMIND_OAUTH_TOKEN_TTL ?? '3600', 10) || 3600,
);

// S1: the ONLY scope whose bearer token may reach /mcp. Tokens issued for
// other scopes (e.g. "registry:read") verify fine but are rejected here —
// scope is meaningful only if the /mcp boundary enforces it.
export const MCP_ACCESS_SCOPE = 'projectmind:mcp';

// Lazy OAuth singletons — never touch the database at module load time.
// `pm mcp` (and any consumer of the package root re-export) imports this
// module BEFORE initializeDependencies() has run; eager `getDatabase()` here
// would throw "Database not initialized" and crash the import. These getters
// only run once an /oauth/* or /mcp request arrives, i.e. after init.
let _oauthRegistry: ClientRegistry | null = null;
let _oauthTokens: TokenService | null = null;

export function getOauthRegistry(): ClientRegistry {
  return (_oauthRegistry ??= new ClientRegistry(getDatabase()));
}

export function getOauthTokens(): TokenService {
  return (_oauthTokens ??= new TokenService(getDatabase(), OAUTH_TOKEN_TTL));
}

export function extractBearerOrHeaderToken(req: http.IncomingMessage): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const alt = req.headers['x-projectmind-token'];
  if (typeof alt === 'string') return alt.trim();
  return undefined;
}

/** Static-token check only (used by /mcp auth and the protected /oauth/register). */
export function isStaticTokenValid(req: http.IncomingMessage): boolean {
  const presented = extractBearerOrHeaderToken(req);
  if (presented === undefined) return false;
  return timingSafeEqual(
    Buffer.from(presented, 'utf8'),
    Buffer.from(HTTP_AUTH_TOKEN ?? '', 'utf8'),
  );
}

/** HTTP authorization check (static token and/or OAuth). */
export function isHttpAuthorized(req: http.IncomingMessage): true | { error: string } {
  // Static bearer (admin) token wins when configured.
  if (HTTP_AUTH_TOKEN && isStaticTokenValid(req)) return true;
  // Dual mode: a valid OAuth access token also authorizes /mcp — but only
  // when it carries the MCP-access scope (S1). Expiry is checked inside
  // verify(); scope is checked here so a "registry:read" token cannot be
  // replayed against the /mcp surface.
  if (OAUTH_ENABLED) {
    const presented = extractBearerOrHeaderToken(req);
    if (presented !== undefined && presented.length > 0) {
      const entry = getOauthTokens().verify(presented);
      if (entry !== null && (entry.scope ?? '').split(/\s+/).includes(MCP_ACCESS_SCOPE))
        return true;
    }
  }
  // Open loopback mode ONLY when no authentication is configured at all.
  if (!HTTP_AUTH_TOKEN && !OAUTH_ENABLED) return true;
  return { error: 'Unauthorized: no token provided.' };
}

/** Timing-safe token comparison. */
export function safeTokenEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Sliding-window per-IP rate limiter (60s window). */
export class HttpRateLimiter {
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

export const httpRateLimiter = new HttpRateLimiter();

export function jsonError(
  res: http.ServerResponse,
  status: number,
  payload: Record<string, string | number | boolean | null>,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(payload));
}
