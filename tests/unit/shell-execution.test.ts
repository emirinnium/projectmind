import { describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawnSync: spawnSyncMock,
}));

import { buildAutopilotHookScript, quotePosixShellArg } from '../../src/cli/commands/autopilot.js';
import {
  resolvePackageManagerCommand,
  runNpmAudit,
  runPackageOutdated,
} from '../../src/cli/commands/deps-fresh-utils.js';

describe('shell execution hardening', () => {
  it('quotes generated hook paths as one shell argument', () => {
    expect(quotePosixShellArg("agent's;$(touch compromised)")).toBe(
      "'agent'\\''s;$(touch compromised)'",
    );

    const script = buildAutopilotHookScript(
      "/tmp/agent's;$(touch compromised)/cli.js",
      '/Program Files/node.exe',
    );
    expect(script).toContain(
      "exec '/Program Files/node.exe' '/tmp/agent'\\''s;$(touch compromised)/cli.js' autopilot pre-commit",
    );
    expect(script).not.toContain('node "');
  });

  it.each([
    ['win32', 'npm.cmd'],
    ['linux', 'npm'],
    ['darwin', 'npm'],
  ] as const)('resolves the package manager without shell lookup on %s', (platform, command) => {
    expect(resolvePackageManagerCommand('npm', platform)).toBe(command);
    expect(resolvePackageManagerCommand('pnpm', platform)).toBe(
      platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    );
  });

  it('runs npm audit with fixed argv and shell disabled', () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ metadata: { vulnerabilities: {} } }),
      stderr: '',
    });

    expect(runNpmAudit('C:\\repo')).toEqual({
      total: 0,
      critical: 0,
      high: 0,
      moderate: 0,
      low: 0,
    });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      resolvePackageManagerCommand('npm'),
      ['audit', '--json'],
      expect.objectContaining({ cwd: 'C:\\repo', shell: false }),
    );
  });

  it('runs outdated checks with validated command names and shell disabled', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '{}', stderr: '' });

    expect(runPackageOutdated('C:\\repo', 'npm')).toEqual(new Map());
    expect(spawnSyncMock).toHaveBeenCalledWith(
      resolvePackageManagerCommand('npm'),
      ['outdated', '--json'],
      expect.objectContaining({ cwd: 'C:\\repo', shell: false }),
    );
  });
});
