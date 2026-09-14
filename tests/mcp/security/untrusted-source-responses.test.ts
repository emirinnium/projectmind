import { describe, expect, it, afterAll } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerStructuralSearchTool } from '../../../src/mcp/tools/structural-search.js';
import { registerFindSymbolReferencesTool } from '../../../src/mcp/tools/symbol-refs.js';
import { registerFindSymbolDefinitionTool } from '../../../src/mcp/tools/symbol-def.js';
import type { McpDependencies } from '../../../src/mcp/tools/types.js';

interface RegisteredTool {
  handler: (args: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

interface ServerRegistry {
  _registeredTools: Record<string, RegisteredTool>;
}

function registered(server: McpServer, name: string): RegisteredTool {
  return (server as unknown as ServerRegistry)._registeredTools[name];
}

function deps(root: string, relativePath: string): McpDependencies {
  return {
    projectRoot: root,
    kg: {
      getAllFiles: () => [{ relativePath, path: join(root, relativePath) }],
    },
  } as unknown as McpDependencies;
}

describe('untrusted source response envelopes', () => {
  const roots: string[] = [];

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  it('marks structural-search snippets and previews as source data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-untrusted-source-'));
    roots.push(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'demo.ts'), 'export function greet() { return "repo"; }\n');

    const server = new McpServer({ name: 'untrusted-structural-test', version: '1.0.0' });
    registerStructuralSearchTool(server, deps(root, 'src/demo.ts'));
    const response = await registered(server, 'structural_search').handler({
      nodeKind: 'FunctionDeclaration',
      dryRun: true,
    });
    const payload = JSON.parse(response.content[0].text) as {
      matches: Array<{
        untrustedContent: { trust: string; sourceKind: string; contentHash: string };
      }>;
    };

    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0].untrustedContent).toMatchObject({
      trust: 'untrusted',
      sourceKind: 'source',
    });
    expect(payload.matches[0].untrustedContent.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('applies file glob filters before validating and reading indexed files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-structural-patterns-'));
    roots.push(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'included.ts'), 'export function included() { return 1; }\n');
    await writeFile(join(root, 'src', 'excluded.ts'), 'export function excluded() { return 2; }\n');

    const server = new McpServer({ name: 'structural-pattern-test', version: '1.0.0' });
    const dependencies = {
      ...deps(root, 'src/included.ts'),
      kg: {
        getAllFiles: () => [
          { relativePath: 'src/included.ts', path: join(root, 'src', 'included.ts') },
          { relativePath: 'src/excluded.ts', path: join(root, 'src', 'excluded.ts') },
        ],
      },
    } as McpDependencies;
    registerStructuralSearchTool(server, dependencies);

    const response = await registered(server, 'structural_search').handler({
      nodeKind: 'FunctionDeclaration',
      filePatterns: ['src/included.ts'],
    });
    const payload = JSON.parse(response.content[0].text) as {
      matches: Array<{ file: string }>;
    };

    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0].file).toContain('included.ts');
    expect(payload.matches[0].file).not.toContain('excluded.ts');
  });

  it('marks language-service reference snippets and confines returned paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-untrusted-refs-'));
    roots.push(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true } }),
    );
    await writeFile(
      join(root, 'src', 'counter.ts'),
      'let counter = 0;\nexport function increment() { counter += 1; return counter; }\n',
    );

    const server = new McpServer({ name: 'untrusted-refs-test', version: '1.0.0' });
    registerFindSymbolReferencesTool(server, deps(root, 'src/counter.ts'));
    const response = await registered(server, 'find_symbol_references').handler({
      file: 'src/counter.ts',
      symbol: 'counter',
    });
    const payload = JSON.parse(response.content[0].text) as {
      references: Array<{
        file: string;
        untrustedContent: { trust: string; sourceKind: string; relativePath?: string };
      }>;
    };

    expect(payload.references.length).toBeGreaterThan(0);
    expect(payload.references.every((reference) => reference.file === 'src/counter.ts')).toBe(true);
    expect(
      payload.references.every((reference) => reference.untrustedContent.trust === 'untrusted'),
    ).toBe(true);
    expect(
      payload.references.every((reference) => reference.untrustedContent.sourceKind === 'source'),
    ).toBe(true);
    expect(
      payload.references.every(
        (reference) => reference.untrustedContent.relativePath === 'src/counter.ts',
      ),
    ).toBe(true);
  });

  it('marks language-service definition snippets as untrusted source data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-untrusted-definition-'));
    roots.push(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true } }),
    );
    await writeFile(
      join(root, 'src', 'definition.ts'),
      'export function unsafeRepositoryName(): string { return "repo-controlled"; }\n',
    );

    const server = new McpServer({ name: 'untrusted-definition-test', version: '1.0.0' });
    registerFindSymbolDefinitionTool(server, deps(root, 'src/definition.ts'));
    const response = await registered(server, 'find_symbol_definition').handler({
      file: 'src/definition.ts',
      symbol: 'unsafeRepositoryName',
    });
    const payload = JSON.parse(response.content[0].text) as {
      definition: {
        snippet: string;
        untrustedContent: { trust: string; sourceKind: string; relativePath?: string };
      } | null;
    };

    expect(payload.definition).not.toBeNull();
    expect(payload.definition?.snippet).toContain('unsafeRepositoryName');
    expect(payload.definition?.untrustedContent).toMatchObject({
      trust: 'untrusted',
      sourceKind: 'source',
      relativePath: 'src/definition.ts',
    });
  });
});
