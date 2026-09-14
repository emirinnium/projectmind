import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('ProjectMind GitHub Action contract', () => {
  it('is a complete bounded cross-platform composite action', async () => {
    const action = await readFile(
      resolve(process.cwd(), '.github/actions/projectmind/action.yml'),
      'utf8',
    );
    expect(action).toContain('using: composite');
    expect(action).toContain('shell: bash');
    expect(action).toContain('shell: pwsh');
    expect(action).toContain('health');
    expect(action).toContain('audit');
    expect(action).toContain('pr-preview');
    expect(action).toContain('GITHUB_OUTPUT');
    expect(action).not.toContain('shell: true');
    expect(action).toMatch(/command must be health, audit, or pr-preview/);
    expect(action).toMatch(/version.*exact published/i);
  });
});
