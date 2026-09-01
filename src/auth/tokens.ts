import { randomBytes, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../storage/database.js';

/**
 * Opaque bearer access tokens (RFC 6750) for the client-credentials flow
 * (RFC 6749 §4.4). Tokens are cryptographically random and persisted in
 * SQLite (`oauth_tokens`) so they survive server restarts. Expiry is enforced
 * in the read query (`expires_at > now`), and issuance runs inside a
 * BEGIN/COMMIT/ROLLBACK transaction so a failed write never leaves a partial
 * row behind.
 *
 * K6: only `sha256:<hex>` of a token is EVER stored (migration 10). The
 * plaintext value is returned to the client exactly once at issuance; anyone
 * who reads the DB file afterwards cannot replay it.
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

/** K6: storage-side token representation — never the plaintext itself. */
export function hashToken(plain: string): string {
  return `sha256:${createHash('sha256').update(plain, 'utf8').digest('hex')}`;
}

export class TokenService {
  constructor(
    private readonly db: DatabaseSync = getDatabase(),
    private readonly ttlSeconds: number = 3600,
  ) {}

  issue(clientId: string, scope?: string): TokenIssueResponse {
    const token = `pm_${randomBytes(24).toString('hex')}`;
    const tokenHash = hashToken(token);
    const now = Date.now();
    const expiresAt = now + this.ttlSeconds * 1000;

    try {
      this.db.exec('BEGIN');
      this.db
        .prepare(
          'INSERT INTO oauth_tokens (token, client_id, scope, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(tokenHash, clientId, scope ?? null, now, expiresAt);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure — original error is the one to surface
      }
      throw error;
    }

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: this.ttlSeconds,
      ...(scope !== undefined ? { scope } : {}),
    };
  }

  /** Validate a bearer token; expired tokens are rejected by the SQL WHERE clause. */
  verify(bearer: string): TokenEntry | null {
    const row = this.db
      .prepare(
        'SELECT token, client_id, scope, issued_at, expires_at FROM oauth_tokens WHERE token = ? AND expires_at > ?',
      )
      .get(hashToken(bearer), Date.now()) as
      | {
          token: string;
          client_id: string;
          scope: string | null;
          issued_at: number;
          expires_at: number;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      clientId: row.client_id,
      ...(row.scope !== null ? { scope: row.scope } : {}),
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    };
  }
}
