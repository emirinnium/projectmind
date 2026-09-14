import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { searchTeamMemoriesSemantic } from '../../src/core/memory/semantic-memory.js';
import { writeFileAtomically } from '../../src/utils/atomic-write.js';
import { stableHash } from '../../src/utils/hash.js';
import { normalizeHostname } from '../../src/utils/hostname.js';
import { currentModuleDir, resolvePackageVersion } from '../../src/utils/version.js';

describe('utility contracts', () => {
  let root = '';

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('produces stable cryptographic hashes and normalizes IPv6 hostnames', () => {
    expect(stableHash('projectmind')).toBe(stableHash('projectmind'));
    expect(stableHash('projectmind')).toHaveLength(64);
    expect(normalizeHostname(' [::1] ')).toBe('::1');
    expect(normalizeHostname('Example.COM')).toBe('example.com');
  });

  it('writes and replaces a file atomically', async () => {
    root = await mkdtemp(join(tmpdir(), 'projectmind-atomic-'));
    const target = join(root, 'state.json');
    writeFileAtomically(target, '{"version":1}\n');
    expect(await readFile(target, 'utf8')).toBe('{"version":1}\n');
    writeFileAtomically(target, '{"version":2}\n');
    expect(await readFile(target, 'utf8')).toBe('{"version":2}\n');
  });

  it('resolves the package version from the current module ancestry', () => {
    expect(resolvePackageVersion(currentModuleDir(import.meta.url))).toMatch(/^\d+\.\d+\.\d+$/);
    expect(resolvePackageVersion(join(tmpdir(), 'projectmind-no-package'))).toBe('unknown');
  });

  it('filters semantic team memories and reports bounded results', async () => {
    const result = await searchTeamMemoriesSemantic(
      () => [
        {
          id: 1,
          agentName: 'agent-a',
          scope: 'decisions',
          key: 'auth',
          value: 'Use the local token validator',
        },
        {
          id: 2,
          agentName: 'agent-b',
          scope: 'notes',
          key: 'release',
          value: 'Publish after the production checks pass',
        },
      ],
      { query: 'authentication', scope: 'decisions', limit: 1, threshold: -1, dim: 8 },
    );
    expect(result.scanned).toBe(1);
    expect(result.returned).toBe(1);
    expect(result.hits[0]).toMatchObject({ id: 1, scope: 'decisions' });
  });
});
