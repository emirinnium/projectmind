import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { AuthError, ClientRegistry } from '../../src/auth/registry.js';
import { TokenService, hashToken } from '../../src/auth/tokens.js';
import { handleOauthRoute } from '../../src/auth/http.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { SCHEMA_SQL } from '../../src/storage/schema.js';

let db: DatabaseSync;

beforeAll(() => {
  db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL); // base tables; migrations extend them (mirrors initDatabase)
  runMigrations(db);
});

beforeEach(() => {
  // Isolated test cases: wipe persisted OAuth state (tokens first — FK).
  db.exec('DELETE FROM oauth_tokens');
  db.exec('DELETE FROM oauth_clients');
});

afterAll(() => {
  db.close();
});

describe('ClientRegistry — RFC 7591 dynamic client registration', () => {
  it('issues client_id + one-time secret; only the hash is stored', () => {
    const reg = new ClientRegistry(db);

    const client = reg.register({
      client_name: 'Smoke Client',
      redirect_uris: ['http://127.0.0.1:3000/callback'],
      grant_types: ['authorization_code', 'client_credentials'],
    });

    expect(client.client_id).toMatch(/^pm_[0-9a-f]{32}$/);
    expect(client.client_secret).toBeTypeOf('string');
    expect(client.client_secret!.length).toBe(64);
    expect((client as { client_secret_hash?: string }).client_secret_hash).toBeUndefined();
    expect(client.client_secret_expires_at).toBe(0);
    expect(client.grant_types).toEqual(['authorization_code', 'client_credentials']);

    // Secret verifies; a random other secret does not.
    expect(reg.authenticate(client.client_id, client.client_secret!)).toBeDefined();
    expect(reg.authenticate(client.client_id, 'a'.repeat(64))).toBeUndefined();

    // The stored form carries the hash, never the plaintext.
    const stored = reg.get(client.client_id)!;
    expect(stored.client_secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(client.client_secret!);
  });

  it('rejects non-https / non-loopback redirect_uris', () => {
    const reg = new ClientRegistry(db);
    expect(() =>
      reg.register({ client_name: 'Bad', redirect_uris: ['http://evil.example.com/cb'] }),
    ).toThrowError(AuthError);
    expect(() =>
      reg.register({ client_name: 'Bad', redirect_uris: ['javascript:alert(1)'] }),
    ).toThrowError(AuthError);
  });

  it('rejects unknown fields (strict metadata validation)', () => {
    const reg = new ClientRegistry(db);
    expect(() => reg.parse({ client_name: 'X', bogus_field: 1 })).toThrowError(/Unrecognized key.*bogus_field/);
    expect(() => reg.register(regOwnSafe())).not.toThrow();
  });

  it('rejects client_credentials with auth method "none"', () => {
    const reg = new ClientRegistry(db);
    expect(() =>
      reg.register({ grant_types: ['client_credentials'], token_endpoint_auth_method: 'none' }),
    ).toThrowError(/client_credentials/);
  });

  it('rejects implicit grants without a redirect_uri', () => {
    const reg = new ClientRegistry(db);
    expect(() => reg.register({ grant_types: ['implicit'] })).toThrowError(/redirect_uri/);
  });

  it('returns the established client for identical re-registration (RFC 7591 §2.2)', () => {
    const reg = new ClientRegistry(db);
    const first = reg.register({ client_name: 'Dup', redirect_uris: ['https://app.example.com/cb'] });
    const second = reg.register({ client_name: 'Dup', redirect_uris: ['https://app.example.com/cb'] });

    expect(second.client_id).toBe(first.client_id);
    expect(second.client_secret).toBeUndefined();
    expect(reg.size).toBe(1);
  });

  it('stores MCP clientInfo and clientCapabilities extensions', () => {
    const reg = new ClientRegistry(db);
    const client = reg.register({
      client_name: 'Cursor clone',
      redirect_uris: ['https://localhost:3000'],
      client_info: { name: 'cursor', version: '1.0.0' },
      client_capabilities: { sampling: {}, roots: { listChanged: true } },
    });

    expect(client.client_info).toEqual({ name: 'cursor', version: '1.0.0' });
    expect(client.client_capabilities).toEqual({ sampling: {}, roots: { listChanged: true } });
    expect(reg.get(client.client_id)!.client_info!.name).toBe('cursor');
  });
});

describe('TokenService — client-credentials access tokens', () => {
  // Tokens FK to oauth_clients: issue() requires a previously-registered
  // client (this mirrors http.ts, which authenticates before issuing).
  function tokenClient(): ClientRegistrationResponse {
    return new ClientRegistry(db).register({
      client_name: 'token-svc',
      redirect_uris: ['https://tok.example.com/cb'],
      grant_types: ['client_credentials'],
    });
  }

  it('issues and verifies tokens with scope', () => {
    const client = tokenClient();
    const ts = new TokenService(db, 3600);
    const res = ts.issue(client.client_id, 'registry:read');

    expect(res.token_type).toBe('Bearer');
    expect(res.expires_in).toBe(3600);
    expect(res.access_token).toMatch(/^pm_[0-9a-f]{48}$/);
    expect(res.scope).toBe('registry:read');

    const entry = ts.verify(res.access_token)!;
    expect(entry.clientId).toBe(client.client_id);
    expect(entry.scope).toBe('registry:read');
  });

  it('rejects unknown tokens', () => {
    expect(new TokenService(db).verify('pm_madeup')).toBeNull();
  });

  it('rejects tokens for unregistered clients (FK integrity)', () => {
    const ts = new TokenService(db, 3600);
    expect(() => ts.issue('pm_no_such_client')).toThrowError(/FOREIGN KEY/);
  });

  it('evicts expired tokens', () => {
    const client = tokenClient();
    const ts = new TokenService(db, 0); // instantly expired
    const res = ts.issue(client.client_id);
    expect(ts.verify(res.access_token)).toBeNull();
  });
});

describe('handleOauthRoute — HTTP surface', () => {
  function ctx(overrides?: { registry?: ClientRegistry; tokens?: TokenService; authorization?: string }) {
    return {
      registry: overrides?.registry ?? new ClientRegistry(db),
      tokens: overrides?.tokens ?? new TokenService(db, 3600),
      authorization: overrides?.authorization,
    };
  }

  it('registers a client over HTTP (201 + Location)', () => {
    const c = ctx();
    const result = handleOauthRoute(
      '/oauth/register',
      JSON.stringify({ client_name: 'web', redirect_uris: ['https://app.example.com/cb'] }),
      'application/json',
      c,
    );
    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.status).toBe(201);
    expect(result.headers.Location).toBe('/oauth/register');
    expect(result.payload.client_id).toMatch(/^pm_/);
    expect(result.payload.client_secret).toBeTypeOf('string');
  });

  it('rejects a bad registration with an RFC 7591 error body', () => {
    const c = ctx();
    const result = handleOauthRoute(
      '/oauth/register',
      JSON.stringify({ redirect_uris: ['http://evil.com/cb'] }),
      'application/json',
      c,
    );
    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.status).toBe(400);
    expect(result.payload.error).toBe('invalid_client_metadata');
    expect(result.payload.error_description).toContain('redirect_uri');
  });

  it('issues a client_credentials token (secret_post)', () => {
    const reg = new ClientRegistry(db);
    const c = ctx({
      registry: reg,
      tokens: new TokenService(db, 3600),
    });
    const client = reg.register({ client_name: 'svc', redirect_uris: ['https://a.example.com/cb'], grant_types: ['client_credentials'] });

    const result = handleOauthRoute(
      '/oauth/token',
      JSON.stringify({
        grant_type: 'client_credentials',
        client_id: client.client_id,
        client_secret: client.client_secret,
        scope: 'registry:read',
      }),
      'application/json',
      c,
    );
    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.status).toBe(200);
    expect(result.headers['Cache-Control']).toBe('no-store');
    expect(result.payload.access_token).toMatch(/^pm_[0-9a-f]{48}$/);
    expect(result.payload.token_type).toBe('Bearer');
    expect(result.payload.scope).toBe('registry:read');

    // The issued token authenticates against the registry-owning service.
    expect(c.tokens.verify(result.payload.access_token as string)!.clientId).toBe(client.client_id);
  });

  it('accepts client_secret_basic on the token endpoint', () => {
    const reg = new ClientRegistry(db);
    const client = reg.register({ client_name: 'basic', redirect_uris: ['https://b.example.com/cb'], token_endpoint_auth_method: 'client_secret_basic', grant_types: ['client_credentials'] });
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');

    const result = handleOauthRoute(
      '/oauth/token',
      JSON.stringify({ grant_type: 'client_credentials' }),
      'application/json',
      { registry: reg, tokens: new TokenService(db), authorization: `Basic ${basic}` },
    );
    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.status).toBe(200);
    expect(result.payload.access_token).toBeTypeOf('string');
  });

  it('rejects bad credentials with invalid_client', () => {
    const reg = new ClientRegistry(db);
    const client = reg.register({ client_name: 'svc2', redirect_uris: ['https://c.example.com/cb'], grant_types: ['client_credentials'] });
    const result = handleOauthRoute(
      '/oauth/token',
      JSON.stringify({ grant_type: 'client_credentials', client_id: client.client_id, client_secret: 'wrong!'.repeat(8) }),
      'application/json',
      ctx({ registry: reg }),
    );
    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.status).toBe(400);
    expect(result.payload.error).toBe('invalid_client');
  });

  it('rejects unsupported grant types', () => {
    const result = handleOauthRoute('/oauth/token', JSON.stringify({ grant_type: 'password' }), 'application/json', ctx());
    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.status).toBe(400);
    expect(result.payload.error).toBe('unsupported_grant_type');
  });

  it('rejects malformed JSON with invalid_request', () => {
    const result = handleOauthRoute('/oauth/token', '{not json', 'application/json', ctx());
    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.status).toBe(400);
    expect(result.payload.error).toBe('invalid_request');
  });

  it('accepts urlencoded bodies on the token endpoint', () => {
    const reg = new ClientRegistry(db);
    const client = reg.register({ client_name: 'form', redirect_uris: ['https://d.example.com/cb'], grant_types: ['client_credentials'] });
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: client.client_id,
      client_secret: client.client_secret!,
    }).toString();

    const result = handleOauthRoute('/oauth/token', body, 'application/x-www-form-urlencoded', ctx({ registry: reg }));
    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.status).toBe(200);
    expect(result.payload.access_token).toBeTypeOf('string');
  });

  it('returns handled:false for unknown paths', () => {
    const result = handleOauthRoute('/oauth/nope', '{}', 'application/json', ctx());
    expect(result.handled).toBe(false);
  });
});

describe('SQLite persistence — OAuth data survives service restarts', () => {
  it('migration 9 created oauth_clients and oauth_tokens tables', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.some((t) => t.name === 'oauth_clients')).toBe(true);
    expect(tables.some((t) => t.name === 'oauth_tokens')).toBe(true);
  });

  it('persists client registrations across registry instances (not RAM)', () => {
    const r1 = new ClientRegistry(db);
    const client = r1.register({
      client_name: 'Persist',
      redirect_uris: ['https://p.example.com/cb'],
      grant_types: ['client_credentials'],
    });

    // Fresh instance on the same DB — as after a server restart.
    const r2 = new ClientRegistry(db);
    const stored = r2.get(client.client_id)!;
    expect(stored.client_name).toBe('Persist');
    expect(stored.client_secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r2.authenticate(client.client_id, client.client_secret!)).toBeDefined();
    expect(r2.size).toBe(1);
  });

  it('persists tokens across service instances (not RAM)', () => {
    const client = new ClientRegistry(db).register({
      client_name: 'tok-persist',
      redirect_uris: ['https://tp.example.com/cb'],
      grant_types: ['client_credentials'],
    });
    const t1 = new TokenService(db, 3600);
    const res = t1.issue(client.client_id, 'registry:read');

    const t2 = new TokenService(db, 3600);
    const entry = t2.verify(res.access_token)!;
    expect(entry.clientId).toBe(client.client_id);
    expect(entry.scope).toBe('registry:read');
    expect(entry.expiresAt).toBeGreaterThan(entry.issuedAt);
  });

  it('rejects expired tokens via the SQL WHERE expires_at clause', () => {
    const client = new ClientRegistry(db).register({
      client_name: 'tok-expiring',
      redirect_uris: ['https://te.example.com/cb'],
      grant_types: ['client_credentials'],
    });
    const ts = new TokenService(db, 0); // instant expiry
    const res = ts.issue(client.client_id);
    expect(ts.verify(res.access_token)).toBeNull();

    // The row still exists; expiry is enforced in the read query
    // (expires_at > now) — proving the guard is SQL-side, not eviction.
    // K6: look up by the STORED sha256 hash, not the plaintext.
    const row = db
      .prepare('SELECT token, expires_at FROM oauth_tokens WHERE token = ?')
      .get(hashToken(res.access_token)) as { token: string; expires_at: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.expires_at).toBeLessThanOrEqual(Date.now());
  });

  it('persists only the sha256 token hash — plaintext is NEVER written (K6)', () => {
    const client = new ClientRegistry(db).register({
      client_name: 'tok-hash',
      redirect_uris: ['https://th.example.com/cb'],
      grant_types: ['client_credentials'],
    });
    const ts = new TokenService(db, 3600);
    const res = ts.issue(client.client_id, 'registry:write');

    const row = db
      .prepare('SELECT token FROM oauth_tokens WHERE client_id = ?')
      .get(client.client_id) as { token: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.token).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row!.token).not.toContain(res.access_token); // no plaintext leak
    expect(row!.token).toBe(hashToken(res.access_token)); // deterministic mapping

    // A DB reader cannot replay the token because the plaintext is absent.
    const rows = db.prepare('SELECT COUNT(*) AS n FROM oauth_tokens WHERE token = ?').get(res.access_token) as { n: number };
    expect(rows.n).toBe(0);
  });
});

// Small helper so the strict-metadata test does not depend on zod error text
// in the happy path.
function regOwnSafe(): Parameters<ClientRegistry['register']>[0] {
  return { client_name: 'safe' };
}