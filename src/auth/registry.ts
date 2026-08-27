import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { getDatabase } from '../storage/database.js';
import type {
  ApplicationType,
  ClientMetadata,
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
 * Dynamic client registry (RFC 7591), persisted in SQLite (`oauth_clients`).
 *
 * Survives server restarts: client records are stored with their SHA-256
 * secret hash (never plaintext); the plaintext secret is returned exactly once
 * in the registration response. Duplicate registration (same client_name +
 * redirect_uris) returns the previously-established client record instead of
 * creating a second one — duplicate lookup and insert run inside a single
 * transaction so the RFC 7591 §2.2 idempotency guarantee holds under
 * concurrent registrations.
 *
 * Writes use explicit BEGIN/COMMIT/ROLLBACK transactions (guardrail: no
 * partial writes on failure).
 */
export class ClientRegistry {
  constructor(private readonly db: DatabaseSync = getDatabase()) {}

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

    const now = Math.floor(Date.now() / 1000);
    const clientId = `pm_${randomBytes(16).toString('hex')}`;
    const clientSecret = authMethod === 'none' ? undefined : randomBytes(32).toString('hex');
    const secretHash = clientSecret !== undefined ? hashSecret(clientSecret) : undefined;

    const metadata: ClientMetadata = {
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
    };

    try {
      this.db.exec('BEGIN');

      // RFC 7591 §2.2: identical metadata again → return the established client.
      const rows = this.db.prepare('SELECT client_id, secret_hash, metadata FROM oauth_clients').all() as Array<{
        client_id: string;
        secret_hash: string | null;
        metadata: string;
      }>;
      for (const row of rows) {
        const existing = JSON.parse(row.metadata) as ClientMetadata;
        if ((existing.client_name ?? '') === (input.client_name ?? '') && sameUriSet(existing.redirect_uris, redirectUris)) {
          const stored: StoredClient =
            row.secret_hash !== null ? { ...existing, client_secret_hash: row.secret_hash } : existing;
          this.db.exec('COMMIT');
          return this.toResponse(stored);
        }
      }

      this.db
        .prepare('INSERT INTO oauth_clients (client_id, secret_hash, metadata, created_at) VALUES (?, ?, ?, ?)')
        .run(clientId, secretHash ?? null, JSON.stringify(metadata), now);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure — original error is the one to surface
      }
      throw error;
    }

    const stored: StoredClient = secretHash !== undefined ? { ...metadata, client_secret_hash: secretHash } : metadata;
    const response = this.toResponse(stored);
    return clientSecret !== undefined ? { ...response, client_secret: clientSecret } : response;
  }

  get(clientId: string): StoredClient | undefined {
    const row = this.db
      .prepare('SELECT client_id, secret_hash, metadata FROM oauth_clients WHERE client_id = ?')
      .get(clientId) as { client_id: string; secret_hash: string | null; metadata: string } | undefined;
    if (row === undefined) return undefined;
    const meta = JSON.parse(row.metadata) as ClientMetadata;
    return row.secret_hash !== null ? { ...meta, client_secret_hash: row.secret_hash } : meta;
  }

  /** Authenticate client_id + client_secret via constant-time digest comparison. */
  authenticate(clientId: string, clientSecret: string): StoredClient | undefined {
    const stored = this.get(clientId);
    if (stored === undefined || stored.client_secret_hash === undefined) return undefined;
    return safeDigestEqual(stored.client_secret_hash, hashSecret(clientSecret)) ? stored : undefined;
  }

  get size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number };
    return row.n;
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