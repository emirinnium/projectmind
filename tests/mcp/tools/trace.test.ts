import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerIngestTraceTool } from '../../../src/mcp/tools/trace.js';
import type { McpDependencies } from '../../../src/mcp/tools/types.js';
import type { KnowledgeGraph } from '../../../src/storage/knowledge-graph.js';
import { SCHEMA_SQL } from '../../../src/storage/schema.js';
import { stableHash } from '../../../src/utils/hash.js';

interface RegisteredTool {
  inputSchema?: unknown;
  handler: (...args: never[]) => unknown;
}

interface ServerRegistry {
  _registeredTools: Record<string, RegisteredTool>;
}

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const path = directories.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe('MCP runtime trace ingestion', () => {
  it('returns workload coverage, source locations, and freshness evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'projectmind-trace-'));
    directories.push(root);
    const source = 'export function start(): void { finish(); }\n';
    await writeFile(join(root, 'runtime.ts'), source, 'utf8');

    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(
      1,
      'trace-test',
      root,
    );
    db.prepare(
      `INSERT INTO files (id, project_id, path, relative_path, language, size_bytes, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      1,
      join(root, 'runtime.ts'),
      'runtime.ts',
      'typescript',
      source.length,
      stableHash(source),
    );
    db.prepare(
      'INSERT INTO functions (id, file_id, name, start_line, end_line, complexity) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(1, 1, 'start', 1, 1, 1);
    db.prepare(
      'INSERT INTO functions (id, file_id, name, start_line, end_line, complexity) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(2, 1, 'finish', 1, 1, 1);

    const graph = {
      db,
      getCurrentProjectId: () => 1,
      clearDynamicCalls: () => 0,
      ingestDynamicCalls: () => ({ inserted: 1, updated: 0, errors: [] as string[] }),
      getFileByPath: (path: string) =>
        path === 'runtime.ts' || path === join(root, 'runtime.ts')
          ? {
              path: join(root, 'runtime.ts'),
              relativePath: 'runtime.ts',
              hash: stableHash(source),
              lastScanned: '2026-09-08 12:00:00',
            }
          : null,
      getAllFiles: () => [
        {
          path: join(root, 'runtime.ts'),
          relativePath: 'runtime.ts',
          hash: stableHash(source),
          lastScanned: '2026-09-08 12:00:00',
        },
      ],
    } as unknown as KnowledgeGraph;
    const deps = { kg: graph, projectRoot: root } as unknown as McpDependencies;
    const server = new McpServer({ name: 'trace-test', version: '1.0.0' });
    registerIngestTraceTool(server, deps);
    const registered = (server as unknown as ServerRegistry)._registeredTools.ingest_trace;
    expect(registered.inputSchema).toBeDefined();

    const handler = registered.handler as unknown as (args: {
      traceData: Array<{
        fromFunctionName: string;
        toFunctionName: string;
        workloadId: string;
        callCount?: number;
        staticMissed?: boolean;
      }>;
      workloadId?: string;
      clear: boolean;
    }) => Promise<{ content: Array<{ text: string }> }>;
    const result = await handler({
      traceData: [
        { fromFunctionName: 'start', toFunctionName: 'finish', workloadId: 'smoke', callCount: 2 },
      ],
      clear: false,
    });
    const payload = JSON.parse(result.content[0].text) as {
      traceCoverage: {
        eventsReceived: number;
        eventsPersisted: number;
        resolvedFunctionNames: number;
        unresolvedFunctionNames: string[];
        functionLocations: Array<{ functionName: string; filePath: string }>;
      };
      evidence: {
        verification: { status: string; runtimeVerified: boolean };
        freshness: { freshFiles: number };
      };
    };
    expect(payload.traceCoverage.eventsReceived).toBe(1);
    expect(payload.traceCoverage.eventsPersisted).toBe(1);
    expect(payload.traceCoverage.resolvedFunctionNames).toBe(2);
    expect(payload.traceCoverage.unresolvedFunctionNames).toEqual([]);
    expect(payload.traceCoverage.functionLocations[0].filePath).toBe('runtime.ts');
    expect(payload.evidence.verification.status).toBe('verified');
    expect(payload.evidence.verification.runtimeVerified).toBe(true);
    expect(payload.evidence.freshness.freshFiles).toBe(1);
    db.close();
  });
});
