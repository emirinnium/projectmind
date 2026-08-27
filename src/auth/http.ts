import { AuthError, ClientRegistry } from './registry.js';
import { TokenService } from './tokens.js';

/**
 * HTTP surface for the OAuth endpoints (used by mcp-server.ts).
 *
 *   POST /oauth/register — RFC 7591 dynamic client registration.
 *   POST /oauth/token    — RFC 6749 §4.4 client-credentials token issuance.
 *
 * JSON bodies are the primary encoding; `application/x-www-form-urlencoded`
 * is also accepted on the token endpoint for classic OAuth clients. Both
 * endpoints are wrapped by `handleOauthRoute`, which normalizes all error
 * paths into RFC error objects ({ error, error_description }).
 */

export type OauthRouteResult =
  | { handled: false }
  | { handled: true; status: number; headers: Record<string, string>; payload: Record<string, unknown> };

export interface OauthRouteContext {
  registry: ClientRegistry;
  tokens: TokenService;
  /** Raw `Authorization` header, used to honor client_secret_basic on the token endpoint. */
  authorization?: string;
}

/** Parse a request body as JSON or URL-encoded form. Throws {@link AuthError} on garbage. */
function parseBody(bodyText: string, contentType: string): Record<string, unknown> {
  const ct = contentType.toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded')) {
    // URLSearchParams yields Record<string,string>, assignable to Record<string,unknown>.
    return Object.fromEntries(new URLSearchParams(bodyText));
  }
  const parsed: unknown = JSON.parse(bodyText);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AuthError('Request body must be a JSON object', 400, 'invalid_request');
  }
  return parsed as Record<string, unknown>;
}

/** Decode `Authorization: Basic base64(client_id:client_secret)`. */
function extractBasicCredentials(authorization?: string): { clientId: string; clientSecret: string } | null {
  if (authorization === undefined) return null;
  const match = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(authorization.trim());
  if (match === null) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return null;
  return { clientId: decoded.slice(0, sep), clientSecret: decoded.slice(sep + 1) };
}

function handleRegister(params: Record<string, unknown>, ctx: OauthRouteContext): OauthRouteResult {
  const input = ctx.registry.parse(params); // throws AuthError (invalid_client_metadata)
  const client = ctx.registry.register(input);
  return {
    handled: true,
    status: 201,
    headers: { Location: '/oauth/register' },
    payload: { ...client },
  };
}

function handleToken(params: Record<string, unknown>, ctx: OauthRouteContext): OauthRouteResult {
  const grantType = params.grant_type;
  if (grantType !== 'client_credentials') {
    throw new AuthError(`unsupported grant_type: ${String(grantType)}`, 400, 'unsupported_grant_type');
  }

  // Client authentication: client_secret_post (body) or client_secret_basic (header).
  const bodyId = params.client_id;
  const bodySecret = params.client_secret;
  const basic = extractBasicCredentials(ctx.authorization);
  const clientId = basic !== null ? basic.clientId : typeof bodyId === 'string' ? bodyId : '';
  const clientSecret = basic !== null ? basic.clientSecret : typeof bodySecret === 'string' ? bodySecret : '';

  const client = ctx.registry.authenticate(clientId, clientSecret);
  if (client === undefined) {
    throw new AuthError('Invalid client credentials', 400, 'invalid_client');
  }

  const scope = typeof params.scope === 'string' && params.scope.length > 0 ? params.scope : undefined;
  return {
    handled: true,
    status: 200,
    headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    payload: { ...ctx.tokens.issue(client.client_id, scope) },
  };
}

/**
 * Route an OAuth request. Returns `handled: false` only for unknown paths —
 * the caller is responsible for its own 404 in that case. All validation and
 * authentication errors are normalized to { error, error_description }.
 */
export function handleOauthRoute(url: string, bodyText: string, contentType: string, ctx: OauthRouteContext): OauthRouteResult {
  try {
    if (url !== '/oauth/register' && url !== '/oauth/token') return { handled: false };
    const params = parseBody(bodyText, contentType);
    return url === '/oauth/register' ? handleRegister(params, ctx) : handleToken(params, ctx);
  } catch (e) {
    if (e instanceof AuthError) {
      return { handled: true, status: e.statusCode, headers: {}, payload: { error: e.code, error_description: e.message } };
    }
    const message = e instanceof Error ? e.message : String(e);
    return { handled: true, status: 400, headers: {}, payload: { error: 'invalid_request', error_description: message } };
  }
}