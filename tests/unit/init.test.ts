import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeProjectFiles } from '@/cli/commands/init.js';

describe('pm init bootstrap', () => {
  it('creates safe local config, ignore and MCP files once without overwriting them', () => {
    const root = mkdtempSync(join(process.env.TEMP ?? '.', 'projectmind-init-'));
    try {
      writeFileSync(join(root, '.gitignore'), 'node_modules/\n', 'utf8');

      expect(initializeProjectFiles(root)).toEqual([
        '.mcp.json',
        '.projectmindrc.json',
        '.pmignore',
      ]);
      expect(initializeProjectFiles(root)).toEqual([]);

      expect(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))).toMatchObject({
        mcpServers: { projectmind: { command: 'projectmind', args: ['mcp'] } },
      });
      expect(JSON.parse(readFileSync(join(root, '.projectmindrc.json'), 'utf8'))).toEqual({
        description: 'ProjectMind config',
      });
      expect(readFileSync(join(root, '.pmignore'), 'utf8')).toContain('.next/');
      expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.projectmindrc.json');
      expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.projectmind/');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
