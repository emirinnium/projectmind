import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGlobalConfigPath, loadConfig, loadEffectiveConfig } from '@/utils/config.js';

describe('configuration layers', () => {
  it('uses global values as defaults and project values as overrides', () => {
    const root = mkdtempSync(join(process.env.TEMP ?? '.', 'projectmind-config-'));
    const previousCwd = process.cwd();
    const previousXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = join(root, 'xdg');
      mkdirSync(join(root, 'project'), { recursive: true });
      process.chdir(join(root, 'project'));
      const globalPath = getGlobalConfigPath();
      mkdirSync(join(root, 'xdg', 'projectmind'), { recursive: true });
      writeFileSync(
        globalPath,
        JSON.stringify({ llm: { model: 'global-model' }, maxDepth: 3 }),
        'utf8',
      );
      writeFileSync(
        join(root, 'project', '.projectmindrc.json'),
        JSON.stringify({ llm: { model: 'project-model' } }),
        'utf8',
      );

      const config = loadEffectiveConfig();
      expect(config.projectRoot).toBe(join(root, 'project'));
      expect(config.llm.model).toBe('project-model');
      expect(config.maxDepth).toBe(3);
    } finally {
      process.chdir(previousCwd);
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads a --root-style working directory without changing process cwd', () => {
    const root = mkdtempSync(join(process.env.TEMP ?? '.', 'projectmind-config-root-'));
    const previousCwd = process.cwd();
    const previousXdg = process.env.XDG_CONFIG_HOME;
    try {
      const selectedRoot = join(root, 'selected');
      mkdirSync(selectedRoot, { recursive: true });
      process.env.XDG_CONFIG_HOME = join(root, 'xdg');
      mkdirSync(join(root, 'xdg', 'projectmind'), { recursive: true });
      writeFileSync(
        join(root, 'xdg', 'projectmind', 'config.json'),
        JSON.stringify({ maxDepth: 2 }),
        'utf8',
      );
      writeFileSync(
        join(selectedRoot, '.projectmindrc.json'),
        JSON.stringify({ maxDepth: 7, projectRoot: '.' }),
        'utf8',
      );
      process.chdir(previousCwd);

      const config = loadConfig(selectedRoot);
      expect(process.cwd()).toBe(previousCwd);
      expect(config.projectRoot).toBe(selectedRoot);
      expect(config.maxDepth).toBe(7);
    } finally {
      process.chdir(previousCwd);
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not inherit the invoking project config when the selected root has none', () => {
    const root = mkdtempSync(join(process.env.TEMP ?? '.', 'projectmind-config-isolation-'));
    const previousCwd = process.cwd();
    const previousXdg = process.env.XDG_CONFIG_HOME;
    try {
      const selectedRoot = join(root, 'selected');
      mkdirSync(selectedRoot, { recursive: true });
      process.env.XDG_CONFIG_HOME = join(root, 'xdg');
      const config = loadConfig(selectedRoot);
      expect(config.projectRoot).toBe(selectedRoot);
      expect(config.llm.provider).toBe('anthropic');
    } finally {
      process.chdir(previousCwd);
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
