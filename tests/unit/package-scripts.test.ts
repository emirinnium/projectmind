import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  scripts?: Record<string, string>;
}

const root = resolve(process.cwd());
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as PackageManifest;

describe('package runtime entrypoints', () => {
  it('starts the MCP server through the generated package entrypoint', () => {
    const startMcp = manifest.scripts?.['start:mcp'];

    expect(startMcp).toContain('dist/mcp-server.js');
    expect(startMcp).not.toContain('dist/mcp/server-start.js');
    expect(existsSync(resolve(root, 'src/mcp-server.ts'))).toBe(true);
  });
});
