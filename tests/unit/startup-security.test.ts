import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  allowRootOutsideProject,
  getExplicitRoot,
  getStartupProjectRoot,
  MCP_CLI_BRIDGE_ENV,
} from '../../src/cli/utils/startup-security.js';

describe('CLI startup root security boundary', () => {
  it('recognizes both --root forms and short -r', () => {
    expect(getExplicitRoot(['scan', '--root', 'C:/repo'])).toBe('C:/repo');
    expect(getExplicitRoot(['scan', '--root=C:/repo'])).toBe('C:/repo');
    expect(getExplicitRoot(['scan', '-r', 'C:/repo'])).toBe('C:/repo');
    expect(getStartupProjectRoot(['scan', '-r', 'C:/repo'], 'C:/current')).toBe(
      resolve('C:/repo'),
    );
    expect(getExplicitRoot(['scan'])).toBeUndefined();
  });

  it('uses an explicit root as the direct CLI confinement boundary', () => {
    expect(getStartupProjectRoot(['scan', '--root', 'C:/repo'], 'C:/current')).toBe(
      resolve('C:/repo'),
    );
    expect(getStartupProjectRoot(['scan'], 'C:/current')).toBe('C:/current');
  });

  it('allows explicit roots for terminal use but never for the MCP child', () => {
    expect(allowRootOutsideProject(['scan', '--root', 'C:/other'])).toBe(true);
    expect(allowRootOutsideProject(['init'])).toBe(true);
    expect(
      allowRootOutsideProject(['scan', '--root', 'C:/other'], {
        [MCP_CLI_BRIDGE_ENV]: '1',
      }),
    ).toBe(false);
  });
});
