import { describe, expect, it } from 'vitest';
import { MetaValidationError, validateRequestMeta } from '../../src/mcp/tools/types.js';
import { validateCliCommand } from '../../src/mcp/tools/cli-bridge.js';
import { runCliCapture } from '../../src/mcp/tools/cli-runner.js';

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
    expect(validateCliCommand(['mcp', '--profile', 'full'])).toBe(false);
  });
});
