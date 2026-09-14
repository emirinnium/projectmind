import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { closeContext, createContext } from '@/cli/utils/context.js';

describe('CLI context root selection', () => {
  it('loads the selected root config and resolves a relative root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-context-root-'));
    const previousCwd = process.cwd();
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(
        join(root, '.projectmindrc.json'),
        JSON.stringify({ projectRoot: '.', maxDepth: 3 }),
        'utf8',
      );
      process.chdir(tmpdir());

      const ctx = await createContext(root);
      try {
        expect(ctx.config.projectRoot).toBe(resolve(root));
        expect(ctx.config.maxDepth).toBe(3);
        expect(ctx.config.databasePath).toBe('.projectmind/pm-knowledge.db');
      } finally {
        closeContext(ctx);
      }
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
