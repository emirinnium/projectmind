import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SCHEMA_SQL } from '../../../src/storage/schema.js';
import { rebuildSourceRangeIndex } from '../../../src/core/retrieval/source-index.js';
import { registerSourceSymbolRangeTool } from '../../../src/mcp/tools/symbol-range.js';
import type { McpDependencies } from '../../../src/mcp/tools/types.js';

describe('get_source_symbol_range MCP tool', () => {
  it('returns source, coordinates and an untrusted content envelope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-mcp-symbol-'));
    const filePath = join(root, 'example.ts');
    const source = 'export function answer() { return 42; }\n';
    writeFileSync(filePath, source, 'utf8');
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (1, ?, ?)').run('test', root);
    db.prepare(
      'INSERT INTO files (id, project_id, path, relative_path, language, size_bytes, hash) VALUES (1, 1, ?, ?, ?, ?, ?)',
    ).run(filePath, 'example.ts', 'typescript', Buffer.byteLength(source), 'unused');
    rebuildSourceRangeIndex(db, 1, 1, filePath, source);

    const server = new McpServer({ name: 'symbol-range-test', version: '1.0.0' });
    registerSourceSymbolRangeTool(server, {
      db,
      projectRoot: root,
      kg: { getCurrentProjectId: () => 1 },
    } as unknown as McpDependencies);
    const registered = (
      server as unknown as {
        _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
      }
    )._registeredTools.get_source_symbol_range;
    const result = (await registered.handler({
      filePath: 'example.ts',
      symbol: 'answer',
      kind: 'function',
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text) as {
      content: string;
      symbol: { symbolPath: string };
      untrustedContent: { sourceKind: string; content: string };
    };
    expect(payload.content).toContain('return 42');
    expect(payload.symbol.symbolPath).toBe('answer');
    expect(payload.untrustedContent.sourceKind).toBe('source');
    expect(payload.untrustedContent.content).toContain('return 42');
    db.close();
  });
});
