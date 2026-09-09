import { describe, expect, it, vi } from 'vitest';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import {
  extractBearerOrHeaderToken,
  isHttpAuthorized,
  isStaticTokenValid,
  safeTokenEqual,
} from '../../src/mcp/http-security.js';

function request(headers: IncomingHttpHeaders): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe('MCP HTTP security', () => {
  it('compares tokens safely, including different lengths', () => {
    expect(safeTokenEqual('secret', 'secret')).toBe(true);
    expect(safeTokenEqual('secret', 'secreT')).toBe(false);
    expect(safeTokenEqual('short', 'a much longer token')).toBe(false);
  });

  it('extracts bearer and alternate header credentials', () => {
    expect(extractBearerOrHeaderToken(request({ authorization: 'Bearer token-1' }))).toBe(
      'token-1',
    );
    expect(extractBearerOrHeaderToken(request({ authorization: 'bearer token-2' }))).toBe(
      'token-2',
    );
    expect(extractBearerOrHeaderToken(request({ 'x-projectmind-token': 'token-3' }))).toBe(
      'token-3',
    );
    expect(extractBearerOrHeaderToken(request({ authorization: 'Basic token-4' }))).toBeUndefined();
  });

  it('rejects invalid static tokens without leaking a length-mismatch exception', () => {
    expect(isStaticTokenValid(request({ authorization: 'Bearer wrong' }))).toBe(false);
    expect(isStaticTokenValid(request({ authorization: 'Bearer ' }))).toBe(false);
  });

  it('requires configured static credentials and accepts only the exact value', () => {
    const options = { staticToken: 'project-secret', oauthEnabled: false };
    expect(isHttpAuthorized(request({}), options)).toBe(false);
    expect(isHttpAuthorized(request({ authorization: 'Bearer wrong' }), options)).toBe(false);
    expect(isHttpAuthorized(request({ authorization: 'Bearer project-secret' }), options)).toBe(
      true,
    );
  });

  it('requires the MCP scope for OAuth credentials', () => {
    const verifyOauthToken = vi.fn((bearer: string) =>
      bearer === 'good-oauth'
        ? { scope: 'projectmind:mcp registry:read' }
        : bearer === 'wrong-scope'
          ? { scope: 'registry:read' }
          : null,
    );
    const options = { staticToken: '', oauthEnabled: true, verifyOauthToken };

    expect(isHttpAuthorized(request({ authorization: 'Bearer good-oauth' }), options)).toBe(true);
    expect(isHttpAuthorized(request({ authorization: 'Bearer wrong-scope' }), options)).toBe(false);
    expect(isHttpAuthorized(request({ authorization: 'Bearer unknown' }), options)).toBe(false);
    expect(verifyOauthToken).toHaveBeenCalledTimes(3);
  });

  it('allows unauthenticated loopback mode only when both auth layers are disabled', () => {
    expect(isHttpAuthorized(request({}), { staticToken: '', oauthEnabled: false })).toBe(true);
  });
});
