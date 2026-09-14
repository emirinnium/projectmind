import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CloneDetector } from '../../../src/core/dedup/clone-detector.js';

describe('CloneDetector', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('finds Type-2 clones after local binding renaming', async () => {
    root = await mkdtemp(join(tmpdir(), 'projectmind-clones-'));
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, 'src', 'first.ts'),
      [
        'export function first(input: number): number {',
        '  const doubled = input * 2;',
        '  const result = doubled + 1;',
        '  return result;',
        '}',
      ].join('\n'),
    );
    await writeFile(
      join(root, 'src', 'second.ts'),
      [
        'export function second(value: number): number {',
        '  const scaled = value * 2;',
        '  const answer = scaled + 1;',
        '  return answer;',
        '}',
      ].join('\n'),
    );

    const result = new CloneDetector(root).detect(['src/first.ts', 'src/second.ts'], {
      minLines: 3,
    });
    expect(result.scannedFiles).toBe(2);
    expect(result.scannedFunctions).toBe(2);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].occurrences.map((item) => item.filePath)).toEqual([
      'src/first.ts',
      'src/second.ts',
    ]);
  });

  it('rejects paths outside the project and ignored files', async () => {
    root = await mkdtemp(join(tmpdir(), 'projectmind-clone-boundary-'));
    await mkdir(join(root, 'ignored'));
    await writeFile(join(root, '.pmignore'), 'ignored/\n');
    await writeFile(join(root, 'ignored', 'secret.ts'), 'export function secret() {}');

    const result = new CloneDetector(root).detect(['../outside.ts', 'ignored/secret.ts']);
    expect(result.scannedFiles).toBe(0);
    expect(result.groups).toHaveLength(0);
  });
});
