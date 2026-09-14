import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase, initDatabase } from '../../src/storage/database.js';
import { ProjectScanner } from '../../src/core/scale/reporting/scanner.js';

describe('large monorepo scan boundary', () => {
  let root: string | undefined;

  afterEach(async () => {
    closeDatabase();
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('records a bounded full scan and a cheap content-addressed incremental scan', async () => {
    root = await mkdtemp(join(tmpdir(), 'projectmind-monorepo-benchmark-'));
    const fileCount = 240;
    const writes: Promise<void>[] = [];
    for (let index = 0; index < fileCount; index++) {
      const packageName = `package-${String(index % 12).padStart(2, '0')}`;
      const packageRoot = join(root, 'packages', packageName, 'src');
      const fileName = `module-${String(index).padStart(3, '0')}.ts`;
      const previous =
        index > 0
          ? `import { value as previous } from './module-${String(index - 1).padStart(3, '0')}';\n`
          : '';
      writes.push(
        mkdir(packageRoot, { recursive: true }).then(() =>
          writeFile(
            join(packageRoot, fileName),
            `${previous}export const value = ${index};\n`,
            'utf8',
          ),
        ),
      );
    }
    await Promise.all(writes);

    initDatabase(':memory:');
    const scanner = new ProjectScanner();
    const full = await scanner.scanProjectWithProfile(root, true);
    expect(full.totalFiles).toBe(fileCount);
    expect(full.scannedFiles).toBe(fileCount);
    expect(full.errorFiles).toBe(0);
    expect(full.durationMs).toBeLessThan(60_000);
    expect(full.filesPerSecond).toBeGreaterThan(2);

    const incremental = await scanner.scanProjectWithProfile(root, false);
    expect(incremental.totalFiles).toBe(fileCount);
    expect(incremental.scannedFiles).toBe(0);
    expect(incremental.errorFiles).toBe(0);
    expect(incremental.durationMs).toBeLessThan(15_000);
  }, 90_000);
});
