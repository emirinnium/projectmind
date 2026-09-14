import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function runCli(root: string, args: string[]): string {
  const cliPath = join(process.cwd(), 'dist', 'cli.js');
  if (!existsSync(cliPath)) {
    throw new Error('CLI isolation test requires a built dist/cli.js; run npm run build first.');
  }
  try {
    return execFileSync(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: { ...process.env, PROJECTMIND_ROOT: root, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 90_000,
      windowsHide: true,
    });
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `CLI command failed: pm ${args.join(' ')}\n${details.stdout ?? ''}\n${details.stderr ?? ''}\n${details.message ?? ''}`,
    );
  }
}

function runCliFrom(cwd: string, args: string[], projectRoot?: string): string {
  const cliPath = join(process.cwd(), 'dist', 'cli.js');
  if (!existsSync(cliPath)) {
    throw new Error(
      'CLI root-selection test requires a built dist/cli.js; run npm run build first.',
    );
  }
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  if (projectRoot === undefined) delete env.PROJECTMIND_ROOT;
  else env.PROJECTMIND_ROOT = projectRoot;
  try {
    return execFileSync(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 90_000,
      windowsHide: true,
    });
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `CLI command failed from ${cwd}: pm ${args.join(' ')}\n${details.stdout ?? ''}\n${details.stderr ?? ''}\n${details.message ?? ''}`,
    );
  }
}

describe('CLI project isolation', () => {
  it('allows an explicit --root from another working directory and stores state there', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-cli-root-'));
    const target = join(root, 'target');
    mkdirSync(join(target, 'src'), { recursive: true });
    writeFileSync(join(target, 'src', 'index.ts'), 'export const answer = 42;\n', 'utf8');
    try {
      const output = runCliFrom(process.cwd(), ['scan', '--root', target, '--full', '--json']);
      const report = JSON.parse(output) as { scanned: number; errors: number };
      expect(report.scanned).toBe(1);
      expect(report.errors).toBe(0);
      expect(existsSync(join(target, '.projectmind', 'pm-knowledge.db'))).toBe(true);
      expect(existsSync(join(root, '.projectmind', 'pm-knowledge.db'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('keeps indexed files attached to the selected project when scanning by ID', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-cli-projects-'));
    let db: DatabaseSync | undefined;
    try {
      const alpha = join(root, 'alpha');
      const beta = join(root, 'beta');
      mkdirSync(join(alpha, 'src'), { recursive: true });
      mkdirSync(join(beta, 'src'), { recursive: true });
      writeFileSync(join(alpha, 'src', 'alpha.ts'), 'export const alpha = true;\n', 'utf8');
      writeFileSync(join(beta, 'src', 'beta.ts'), 'export const beta = true;\n', 'utf8');

      const alphaOutput = runCli(root, ['project', 'create', 'alpha', alpha]);
      const betaOutput = runCli(root, ['project', 'create', 'beta', beta]);
      const alphaId = /created with ID (\d+)/i.exec(alphaOutput)?.[1];
      const betaId = /created with ID (\d+)/i.exec(betaOutput)?.[1];
      expect(alphaId).toBeDefined();
      expect(betaId).toBeDefined();
      expect(alphaId).not.toBe(betaId);

      runCli(root, ['scan', '--project', alphaId!, '--full']);
      runCli(root, ['scan', '--project', betaId!, '--full']);

      db = new DatabaseSync(join(root, '.projectmind', 'pm-knowledge.db'), { readOnly: true });
      const rows = db
        .prepare('SELECT project_id, relative_path FROM files ORDER BY project_id, relative_path')
        .all() as Array<{ project_id: number; relative_path: string }>;
      expect(rows).toEqual([
        { project_id: Number(alphaId), relative_path: 'src/alpha.ts' },
        { project_id: Number(betaId), relative_path: 'src/beta.ts' },
      ]);
      expect(
        (
          db
            .prepare('SELECT COUNT(*) AS count FROM files WHERE project_id = ?')
            .get(Number(alphaId)) as {
            count: number;
          }
        ).count,
      ).toBe(1);
      expect(
        (
          db
            .prepare('SELECT COUNT(*) AS count FROM files WHERE project_id = ?')
            .get(Number(betaId)) as {
            count: number;
          }
        ).count,
      ).toBe(1);
    } finally {
      db?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
