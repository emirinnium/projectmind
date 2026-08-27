/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591) metadata + client-credentials
 * token types (RFC 6749 §4.4), extended with the MCP client identity fields
 * (`client_info` / `client_capabilities`) captured from the initialize handshake.
 */

export type ApplicationType = 'native' | 'web';

export type GrantType = 'authorization_code' | 'client_credentials' | 'refresh_token' | 'implicit';

export type TokenEndpointAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

/** MCP spec clientInfo (Client Implementations). */
export interface McpClientInfo {
  name?: string;
  version?: string;
}

/**
 * Free-form MCP capability map (e.g. `{ sampling: {}, roots: {} }`).
 * This is an HTTP API boundary — arbitrary client JSON is stored as-is, so
 * the value type is deliberately `unknown`.
 */
export type McpClientCapabilities = Record<string, unknown>;

/**
 * RFC 7591 §2 client metadata, as exposed in registration responses and
 * stored by the registry (secret kept out — see {@link StoredClient}).
 */
export interface ClientMetadata {
  client_id: string;
  /** Epoch seconds at which the record was established. */
  client_id_issued_at: number;
  /** Epoch seconds of secret expiry; 0 = never expires. */
  client_secret_expires_at: number;
  application_type?: ApplicationType;
  client_name?: string;
  client_uri?: string;
  redirect_uris: string[];
  grant_types: GrantType[];
  token_endpoint_auth_method: TokenEndpointAuthMethod;
  scope?: string;
  contacts: string[];
  /** MCP extension — client identity from the initialize handshake. */
  client_info?: McpClientInfo;
  /** MCP extension — client capability map from the initialize handshake. */
  client_capabilities?: McpClientCapabilities;
}

/** Internal storage form: the secret is only ever kept as a SHA-256 hash. */
export interface StoredClient extends ClientMetadata {
  client_secret_hash?: string;
}

/** Registration response — stored metadata WITHOUT the secret hash, plus the one-time plaintext secret when issued. */
export type ClientRegistrationResponse = Omit<StoredClient, 'client_secret_hash'> & { client_secret?: string };

/** Structural shape of a validated RFC 7591 registration payload. */
export interface ClientRegistrationInput {
  application_type?: ApplicationType;
  client_name?: string;
  client_uri?: string;
  redirect_uris?: string[];
  grant_types?: GrantType[];
  token_endpoint_auth_method?: TokenEndpointAuthMethod;
  scope?: string;
  contacts?: string[];
  client_info?: McpClientInfo;
  client_capabilities?: McpClientCapabilities;
}