import { randomBytes } from 'node:crypto';

/**
 * Opaque bearer access tokens (RFC 6750) for the client-credentials flow
 * (RFC 6749 §4.4). Tokens are cryptographically random, stored in-memory with
 * an expiry, and NOT persisted across restarts (a restart invalidates them —
 * clients re-issue via /oauth/token).
 */

export interface TokenEntry {
  clientId: string;
  scope?: string;
  issuedAt: number;
  expiresAt: number;
}

/** RFC 6749 §5.1 success response shape. */
export interface TokenIssueResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope?: string;
}

export class TokenService {
  private readonly tokens = new Map<string, TokenEntry>();

  constructor(private readonly ttlSeconds: number = 3600) {}

  issue(clientId: string, scope?: string): TokenIssueResponse {
    const token = `pm_${randomBytes(24).toString('hex')}`;
    const now = Date.now();
    this.tokens.set(token, { clientId, scope, issuedAt: now, expiresAt: now + this.ttlSeconds * 1000 });
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: this.ttlSeconds,
      ...(scope !== undefined ? { scope } : {}),
    };
  }

  /** Validate a bearer token; expired tokens are evicted and rejected. */
  verify(bearer: string): TokenEntry | null {
    const entry = this.tokens.get(bearer);
    if (entry === undefined) return null;
    if (Date.now() >= entry.expiresAt) {
      this.tokens.delete(bearer);
      return null;
    }
    return entry;
  }
}