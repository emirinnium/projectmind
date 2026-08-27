import { describe, it, expect } from 'vitest';
import { validateCliCommand, ALLOWLISTED_CLI_COMMANDS } from '../../src/mcp/tools/cli-bridge.js';

describe('validateCliCommand (run_cli sandbox — default-deny whitelist)', () => {
  it('rejects non-allowlisted root commands (git, npx, rm, echo, ...)', () => {
    expect(validateCliCommand(['git', 'status'])).toBe(false);
    expect(validateCliCommand(['git', 'clone'])).toBe(false);
    expect(validateCliCommand(['npx', '-y', '@emirhanturker/projectmind@latest', 'mcp'])).toBe(false);
    expect(validateCliCommand(['rm', '-rf', '/'])).toBe(false);
    expect(validateCliCommand(['node', 'evil.js'])).toBe(false);
    expect(validateCliCommand(['echo', 'pwned'])).toBe(false);
  });

  it('rejects empty and mcp/init roots (guard blacklist)', () => {
    expect(validateCliCommand([])).toBe(false);
    expect(validateCliCommand(['mcp'])).toBe(false);
    expect(validateCliCommand(['init'])).toBe(false);
    expect(validateCliCommand(['mcp', '--stdio'])).toBe(false);
  });

  it('allows whitelisted subcommands exactly', () => {
    expect(validateCliCommand(['doctor', 'scan-health'])).toBe(true);
    expect(validateCliCommand(['doctor'])).toBe(true); // bare root
    expect(validateCliCommand(['license', 'check'])).toBe(true);
    expect(validateCliCommand(['license', 'report'])).toBe(true);
    expect(validateCliCommand(['license'])).toBe(true);
  });

  it('rejects mutating/non-whitelisted doctor subcommands', () => {
    expect(validateCliCommand(['doctor', 'fix-imports'])).toBe(false);
    expect(validateCliCommand(['doctor', 'clean-debt'])).toBe(false);
    expect(validateCliCommand(['doctor', 'rebuild-index'])).toBe(false); // guard blacklist too
    expect(validateCliCommand(['doctor', 'scan-health', 'clean-debt'])).toBe(false); // trailing non-flag
  });

  it('allows trailing flags after a whitelisted subcommand', () => {
    expect(validateCliCommand(['doctor', 'scan-health', '--json'])).toBe(true);
    expect(validateCliCommand(['doctor', 'scan-health', '--deep', '--offline'])).toBe(true);
    expect(validateCliCommand(['license', 'check', '--format', 'json'])).toBe(true);
  });

  it('rejects unknown license subcommands', () => {
    expect(validateCliCommand(['license', 'delete'])).toBe(false);
    expect(validateCliCommand(['license', 'install'])).toBe(false);
  });

  it('allows flag-only roots with flags, rejects subcommand-like tokens', () => {
    expect(validateCliCommand(['churn', '--since', '30'])).toBe(true);
    expect(validateCliCommand(['churn', '--format', 'json'])).toBe(true);
    expect(validateCliCommand(['churn'])).toBe(true);
    expect(validateCliCommand(['churn', 'clone'])).toBe(false); // subcommand-like token
    expect(validateCliCommand(['report', '--type', 'debt'])).toBe(true);
    expect(validateCliCommand(['report', 'delete'])).toBe(false);
    expect(validateCliCommand(['secrets-life', '--scan', '--format', 'json'])).toBe(true);
    expect(validateCliCommand(['secrets-life', 'scan'])).toBe(false);
  });

  it('blocks layers --auto-fix (writes fixes) but allows read-only layers flags', () => {
    expect(validateCliCommand(['layers', '--auto-fix'])).toBe(false); // guard blacklist
    expect(validateCliCommand(['layers', '--format', 'json'])).toBe(true);
    expect(validateCliCommand(['layers'])).toBe(true);
  });

  it('blocks destructive subcommands through the guard (defense in depth)', () => {
    expect(validateCliCommand(['project', 'delete', '5'])).toBe(false);
    expect(validateCliCommand(['data-flow', 'clear'])).toBe(false);
    expect(validateCliCommand(['trace', 'clear'])).toBe(false);
    expect(validateCliCommand(['debt', 'clear'])).toBe(false);
    expect(validateCliCommand(['debt', 'clear-patterns'])).toBe(false);
  });

  it('exposes an allowlist that covers every documented bridge root', () => {
    for (const root of ALLOWLISTED_CLI_COMMANDS) {
      expect(validateCliCommand([root])).toBe(true);
    }
  });
});