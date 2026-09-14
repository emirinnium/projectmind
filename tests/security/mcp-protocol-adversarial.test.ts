import { describe, expect, it } from 'vitest';
import { MetaValidationError, validateRequestMeta } from '../../src/mcp/tools/types.js';
import { validateCliCommand } from '../../src/mcp/tools/cli-bridge.js';
import { isBlockedCliInvocation } from '../../src/mcp/tools/guard.js';
import { runCliCapture } from '../../src/mcp/tools/cli-runner.js';
import {
  assertHttpBindingSecurity,
  isLoopbackBindHost,
} from '../../src/mcp/http-security.js';
import { normalizeRequestPath } from '../../src/mcp/http-transport.js';

describe('MCP protocol adversarial boundary', () => {
  it('accepts generic SDK metadata but rejects a malformed ProjectMind envelope', () => {
    expect(() => validateRequestMeta({ params: { _meta: { progressToken: 1 } } })).not.toThrow();
    expect(() =>
      validateRequestMeta({ params: { _meta: { protocolVersion: '2025', clientInfo: {} } } }),
    ).toThrow(MetaValidationError);
  });

  it('keeps command execution default-deny against shell-like tokens and restricted roots', async () => {
    expect(validateCliCommand(['doctor', 'scan-health', '--format=json'])).toBe(true);
    expect(validateCliCommand(['doctor', 'scan-health', '&&', 'whoami'])).toBe(false);
    const blockedPath = await runCliCapture(['report', '--output', '../outside.json'], {
      projectRoot: process.cwd(),
    });
    expect(blockedPath.ok).toBe(false);
    expect(blockedPath.stderr).toContain('blocked by ProjectMind guard');
    const blockedShortRoot = await runCliCapture(['context-budget', '-r', '../outside'], {
      projectRoot: process.cwd(),
    });
    expect(blockedShortRoot.ok).toBe(false);
    expect(blockedShortRoot.stderr).toContain('blocked by ProjectMind guard');
    expect(validateCliCommand(['mcp', '--profile', 'full'])).toBe(false);
    expect(isBlockedCliInvocation(['mcp-init', 'codex'])).toBe(true);
    expect(isBlockedCliInvocation(['init-mcp', 'codex'])).toBe(true);
  });

  it('fails closed for unauthenticated non-loopback HTTP bindings', () => {
    expect(isLoopbackBindHost('127.0.0.1')).toBe(true);
    expect(isLoopbackBindHost('[::1]')).toBe(true);
    expect(isLoopbackBindHost('0.0.0.0')).toBe(false);
    expect(() => assertHttpBindingSecurity('0.0.0.0', false)).toThrow(/Refusing unauthenticated/);
    expect(() => assertHttpBindingSecurity('0.0.0.0', true)).not.toThrow();
  });

  it('canonicalizes HTTP paths without trusting query strings', () => {
    expect(normalizeRequestPath('/mcp?client=1')).toBe('/mcp');
    expect(normalizeRequestPath('/mcp/')).toBe('/mcp');
    expect(normalizeRequestPath('/oauth/token?grant_type=client_credentials')).toBe('/oauth/token');
    expect(normalizeRequestPath(undefined)).toBeNull();
  });
});
