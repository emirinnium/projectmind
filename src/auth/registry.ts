import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  ApplicationType,
  ClientRegistrationInput,
  ClientRegistrationResponse,
  GrantType,
  StoredClient,
  TokenEndpointAuthMethod,
} from './types.js';

/**
 * Error carrying an RFC 7591 / RFC 6749 error code + HTTP status for the OAuth
 * HTTP surface. `code` matches the JSON `error` field of the response body.
 */
export class AuthError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 400, code = 'invalid_client_metadata') {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

// --- MCP spec extensions ---------------------------------------------------
// `client_info` / `client_capabilities` mirror the MCP initialize handshake
// so a registering client can persist its identity and capability map.

const mcpClientInfoSchema = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
  })
  .optional();

/**
 * Capability map is free-form JSON (roots, sampling, …). HTTP API boundary —
 * arbitrary client JSON must round-trip as-is.
 */
const mcpClientCapabilitiesSchema = z.record(z.string(), z.unknown()).optional();

/**
 * RFC 7591 §2 registration metadata, plus the MCP `client_info` /
 * `client_capabilities` extensions. `.strict()` rejects unknown fields with
 * `invalid_client_metadata` per RFC 7591 §3.2.1 (field name/type violations).
 */
export const clientRegistrationSchema = z
  .object({
    application_type: z.enum(['native', 'web']).optional(),
    client_name: z.string().max(200).optional(),
    client_uri: z.string().url().optional(),
    redirect_uris: z.array(z.string()).optional(),
    grant_types: z.array(z.enum(['authorization_code', 'client_credentials', 'refresh_token', 'implicit'])).optional(),
    token_endpoint_auth_method: z.enum(['client_secret_basic', 'client_secret_post', 'none']).optional(),
    scope: z.string().optional(),
    contacts: z.array(z.string()).optional(),
    client_info: mcpClientInfoSchema,
    client_capabilities: mcpClientCapabilitiesSchema,
  })
  .strict();

/** `https` or loopback `http` (localhost / 127.0.0.1 / ::1) — RFC 7591 §2.1. */
function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    return (
      u.protocol === 'http:' &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time comparison of two SHA-256 hex digests (always 64 chars). */
function safeDigestEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Order-insensitive set equality for redirect_uri lists (RFC 7591 duplicate detection). */
function sameUriSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((uri) => setA.has(uri));
}

/**
 * In-memory dynamic client registry (RFC 7591).
 *
 * Secrets are never stored in plaintext: only a SHA-256 hash is kept, and the
 * plaintext secret is returned exactly once in the registration response.
 * Duplicate registration (same client_name + redirect_uris) returns the
 * previously-established client record instead of creating a second one.
 */
export class ClientRegistry {
  private readonly clients = new Map<string, StoredClient>();

  /** Validate an RFC 7591 registration payload (throws {@link AuthError}). */
  parse(input: unknown): ClientRegistrationInput {
    const result = clientRegistrationSchema.safeParse(input);
    if (!result.success) {
      const issue = result.error.issues[0];
      const where = issue !== undefined && issue.path.length > 0 ? issue.path.join('.') : 'payload';
      const detail = issue !== undefined ? issue.message : 'invalid client metadata';
      throw new AuthError(`${where}: ${detail}`);
    }
    return result.data;
  }

  /** Register a dynamic client (RFC 7591 §2). Secret plaintext, if any, is returned once. */
  register(input: ClientRegistrationInput): ClientRegistrationResponse {
    const redirectUris = input.redirect_uris ?? [];
    const badUri = redirectUris.find((uri) => !isValidRedirectUri(uri));
    if (badUri !== undefined) {
      throw new AuthError(`redirect_uri must be https (or loopback http): ${badUri}`);
    }

    const grantTypes: GrantType[] = input.grant_types ?? ['authorization_code'];
    const authMethod: TokenEndpointAuthMethod = input.token_endpoint_auth_method ?? 'client_secret_basic';
    const applicationType: ApplicationType = input.application_type ?? 'web';

    if (authMethod === 'none' && grantTypes.includes('client_credentials')) {
      throw new AuthError('grant_type "client_credentials" requires token_endpoint_auth_method other than "none"');
    }
    if (grantTypes.includes('implicit') && redirectUris.length === 0) {
      throw new AuthError('grant_type "implicit" requires at least one redirect_uri');
    }

    // RFC 7591 §2.2: identical metadata again → return the established client.
    for (const existing of this.clients.values()) {
      if ((existing.client_name ?? '') === (input.client_name ?? '') && sameUriSet(existing.redirect_uris, redirectUris)) {
        return this.toResponse(existing);
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const clientId = `pm_${randomBytes(16).toString('hex')}`;
    const clientSecret = authMethod === 'none' ? undefined : randomBytes(32).toString('hex');

    const stored: StoredClient = {
      client_id: clientId,
      client_id_issued_at: now,
      client_secret_expires_at: 0,
      application_type: applicationType,
      client_name: input.client_name,
      client_uri: input.client_uri,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      token_endpoint_auth_method: authMethod,
      scope: input.scope,
      contacts: input.contacts ?? [],
      client_info: input.client_info,
      client_capabilities: input.client_capabilities,
      ...(clientSecret !== undefined ? { client_secret_hash: hashSecret(clientSecret) } : {}),
    };
    this.clients.set(clientId, stored);

    const response = this.toResponse(stored);
    return clientSecret !== undefined ? { ...response, client_secret: clientSecret } : response;
  }

  get(clientId: string): StoredClient | undefined {
    return this.clients.get(clientId);
  }

  /** Authenticate client_id + client_secret via constant-time digest comparison. */
  authenticate(clientId: string, clientSecret: string): StoredClient | undefined {
    const stored = this.clients.get(clientId);
    if (stored === undefined || stored.client_secret_hash === undefined) return undefined;
    return safeDigestEqual(stored.client_secret_hash, hashSecret(clientSecret)) ? stored : undefined;
  }

  get size(): number {
    return this.clients.size;
  }

  /** Public response form — secret hash is never exposed. */
  private toResponse(stored: StoredClient): ClientRegistrationResponse {
    return {
      client_id: stored.client_id,
      client_id_issued_at: stored.client_id_issued_at,
      client_secret_expires_at: stored.client_secret_expires_at,
      application_type: stored.application_type,
      client_name: stored.client_name,
      client_uri: stored.client_uri,
      redirect_uris: stored.redirect_uris,
      grant_types: stored.grant_types,
      token_endpoint_auth_method: stored.token_endpoint_auth_method,
      scope: stored.scope,
      contacts: stored.contacts,
      client_info: stored.client_info,
      client_capabilities: stored.client_capabilities,
    };
  }
}