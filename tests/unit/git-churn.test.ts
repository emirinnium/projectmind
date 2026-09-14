import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectGitChurn as collectCoreChurn } from '../../src/core/debt/git-churn.js';
import { collectGitChurn as collectCliChurn } from '../../src/cli/utils/git-churn.js';

describe('git churn path parsing', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('includes root-level files on Windows and POSIX repositories', async () => {
    root = await mkdtemp(join(tmpdir(), 'projectmind-churn-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'package.json'), '{}\n', 'utf8');
    await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=ProjectMind Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'initial',
        '--quiet',
      ],
      { cwd: root },
    );

    for (const collect of [collectCoreChurn, collectCliChurn]) {
      const churn = collect(root, 3650);
      expect(churn.get('package.json')).toMatchObject({ count: 1 });
      expect(churn.get('src/index.ts')).toMatchObject({ count: 1 });
    }
  });
});
