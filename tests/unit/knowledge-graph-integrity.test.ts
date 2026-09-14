import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KnowledgeGraph } from '../../src/storage/kg/graph.js';
import { createIsolatedDatabase } from '../test-helpers/database.js';
import type { FileStructure } from '../../src/parser/ast-parser.js';

describe('KnowledgeGraph — dynamic calls, deletion, and path lookup hardening', () => {
  let db: ReturnType<typeof createIsolatedDatabase>['db'];
  let kg: KnowledgeGraph;
  let cleanup: ReturnType<typeof createIsolatedDatabase>['cleanup'];

  function makeStruct(filePath: string): FileStructure {
    return {
      filePath,
      language: 'typescript',
      sizeBytes: 120,
      hash: `hash-${filePath}`,
      imports: [],
      functions: [
        {
          name: 'knownFn',
          signature: 'knownFn(): void',
          returnType: 'void',
          startLine: 1,
          endLine: 3,
          complexity: 1,
          kind: 'function',
          parameters: [],
          isExported: true,
          isAsync: false,
          cyclomaticComplexity: 1,
        },
      ],
      classes: [],
      exports: ['knownFn'],
      lines: 3,
    };
  }

  beforeEach(() => {
    const isolated = createIsolatedDatabase();
    db = isolated.db;
    cleanup = isolated.cleanup;
    kg = new KnowledgeGraph(db);
  });

  afterEach(() => {
    cleanup();
  });

  describe('ingestDynamicCalls — ensureFunction never fabricates rows', () => {
    it('unknown function names insert nothing and report errors', async () => {
      const struct = makeStruct('/proj/src/a.ts');
      const fileId = await kg.upsertFile(struct, 'src/a.ts');
      await kg.storeFileDetails(fileId, struct);

      const before = (db.prepare('SELECT COUNT(*) AS n FROM functions').get() as { n: number }).n;
      expect(before).toBe(1); // only knownFn from storeFileDetails

      const result = kg.ingestDynamicCalls([
        { fromFunctionName: 'ghostFrom', toFunctionName: 'ghostTo', workloadId: 'w1' },
      ]);

      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);

      // No phantom function rows under arbitrary files.
      const after = (db.prepare('SELECT COUNT(*) AS n FROM functions').get() as { n: number }).n;
      expect(after).toBe(before);
    });

    it('known function names insert the dynamic call', async () => {
      const struct = makeStruct('/proj/src/b.ts');
      const fileId = await kg.upsertFile(struct, 'src/b.ts');
      await kg.storeFileDetails(fileId, struct);

      const result = kg.ingestDynamicCalls([
        { fromFunctionName: 'knownFn', toFunctionName: 'knownFn', workloadId: 'w1' },
      ]);

      expect(result.inserted + result.updated).toBe(1);
      expect(result.errors).toEqual([]);
    });
  });

  describe('getFileByPath — normalization + case-insensitive fallback', () => {
    it('resolves backslash-separated and wrong-case lookups to the same file', async () => {
      const struct = makeStruct('/proj/src/deep/Mod.ts');
      const fileId = await kg.upsertFile(struct, 'src/deep/Mod.ts');

      const byBackslash = kg.getFileByPath('src\\deep\\Mod.ts');
      expect(byBackslash).not.toBeNull();
      expect(byBackslash?.id).toBe(fileId);

      const byWrongCase = kg.getFileByPath('src/deep/mod.ts');
      expect(byWrongCase).not.toBeNull();
      expect(byWrongCase?.id).toBe(fileId);
    });
  });

  it('removes a file and cascades its graph records plus vector entry', async () => {
    const struct = makeStruct('/proj/src/deleted.ts');
    const fileId = await kg.upsertFile(struct, 'src/deleted.ts');
    await kg.storeFileDetails(fileId, struct);

    expect(kg.getFileByPath('src/deleted.ts')).not.toBeNull();
    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM functions WHERE file_id = ?').get(fileId) as {
          n: number;
        }
      ).n,
    ).toBe(1);

    expect(kg.removeFile('src/deleted.ts')).toBe(true);
    expect(kg.removeFile('src/deleted.ts')).toBe(false);
    expect(kg.getFileByPath('src/deleted.ts')).toBeNull();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM files WHERE id = ?').get(fileId) as { n: number }).n,
    ).toBe(0);
    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM functions WHERE file_id = ?').get(fileId) as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });

  describe('relative import graph resolution', () => {
    it('persists and returns parser-provided named import bindings', async () => {
      const importerStruct: FileStructure = {
        ...makeStruct('/proj/src/importer.ts'),
        imports: [{ source: './utils', named: ['defaultExport', 'namedExport'], kind: 'import' }],
      };
      const importer = await kg.upsertFile(importerStruct, 'src/importer.ts');

      await kg.storeFileDetails(importer, importerStruct);

      expect(kg.getImports(importer)).toEqual([
        { source: './utils', named: ['defaultExport', 'namedExport'], kind: 'import' },
      ]);
    });

    it('stores resolved paths for JavaScript imports backed by TypeScript sources', async () => {
      const target = await kg.upsertFile(
        makeStruct('/proj/src/feature/utils.ts'),
        'src/feature/utils.ts',
      );
      const importerStruct: FileStructure = {
        ...makeStruct('/proj/src/feature/importer.ts'),
        imports: [{ source: './utils.js', named: [], kind: 'relative' }],
      };
      const importer = await kg.upsertFile(importerStruct, 'src/feature/importer.ts');

      await kg.storeFileDetails(importer, importerStruct);

      const row = db
        .prepare('SELECT resolved, resolved_path FROM imports WHERE file_id = ?')
        .get(importer) as { resolved: number; resolved_path: string };
      expect(row).toEqual({ resolved: 1, resolved_path: 'src/feature/utils.ts' });
      expect(target).toBeGreaterThan(0);
    });

    it('resolves relative imports from the importing file directory', async () => {
      const importer = await kg.upsertFile(
        makeStruct('/proj/src/feature/importer.ts'),
        'src/feature/importer.ts',
      );
      const target = await kg.upsertFile(
        makeStruct('/proj/src/feature/utils.ts'),
        'src/feature/utils.ts',
      );
      db.prepare(
        'INSERT INTO imports (file_id, source, kind, resolved, resolved_path) VALUES (?, ?, ?, ?, ?)',
      ).run(importer, './utils', 'relative', 1, 'src/feature/utils.ts');

      const details = kg.getImportsWithDetails(importer);
      expect(details).toHaveLength(1);
      expect(details[0]?.resolvedFile?.id).toBe(target);

      const traced = kg.traceImports(importer, 5);
      expect(traced.map((entry) => entry.file.id)).toContain(target);

      const graph = kg.getDependencyGraph('src/feature');
      expect(graph.edges).toContainEqual({
        from: 'src/feature/importer.ts',
        to: 'src/feature/utils.ts',
        kind: 'relative',
      });
    });

    it('resolves extensionless imports inside dotted directories', async () => {
      const target = await kg.upsertFile(
        makeStruct('/proj/src/feature.v2/utils.ts'),
        'src/feature.v2/utils.ts',
      );
      const importer = await kg.upsertFile(
        makeStruct('/proj/src/feature.v2/importer.ts'),
        'src/feature.v2/importer.ts',
      );
      const resolved = kg.resolveImportSource('./utils', 'src/feature.v2');

      expect(resolved?.id).toBe(target);
      expect(importer).toBeGreaterThan(0);
    });

    it('refreshes extensionless imports inside dotted directories', async () => {
      const importerStruct: FileStructure = {
        ...makeStruct('/proj/src/feature.v2/importer.ts'),
        imports: [{ source: './utils', named: [], kind: 'relative' }],
      };
      const importer = await kg.upsertFile(importerStruct, 'src/feature.v2/importer.ts');
      await kg.storeFileDetails(importer, importerStruct);
      await kg.upsertFile(makeStruct('/proj/src/feature.v2/utils.ts'), 'src/feature.v2/utils.ts');
      db.prepare('UPDATE imports SET resolved = 0, resolved_path = NULL WHERE file_id = ?').run(
        importer,
      );

      expect(kg.refreshImportResolution()).toBe(1);
      expect(
        db.prepare('SELECT resolved, resolved_path FROM imports WHERE file_id = ?').get(importer),
      ).toEqual({ resolved: 1, resolved_path: 'src/feature.v2/utils.ts' });
    });

    it('persists only resolvable static AST call edges', async () => {
      const targetStruct: FileStructure = {
        ...makeStruct('/proj/src/target.ts'),
        functions: [
          {
            ...makeStruct('/proj/src/target.ts').functions[0]!,
            name: 'callee',
            signature: 'callee(): void',
          },
        ],
      };
      const target = await kg.upsertFile(targetStruct, 'src/target.ts');
      await kg.storeFileDetails(target, targetStruct);
      const callerStruct: FileStructure = {
        ...makeStruct('/proj/src/caller.ts'),
        functions: [
          {
            ...makeStruct('/proj/src/caller.ts').functions[0]!,
            name: 'caller',
            signature: 'caller(): void',
          },
        ],
        imports: [{ source: './target', named: ['callee'], kind: 'import' }],
        staticCalls: [
          { fromFunctionName: 'caller', toFunctionName: 'callee', line: 2 },
          { fromFunctionName: 'caller', toFunctionName: 'unknown', line: 3 },
        ],
      };
      const caller = await kg.upsertFile(callerStruct, 'src/caller.ts');
      await kg.storeFileDetails(caller, callerStruct);

      expect(
        db
          .prepare(
            `SELECT c.dynamic, from_f.name AS fromName, to_f.name AS toName
             FROM calls c
             JOIN functions from_f ON from_f.id = c.from_function_id
             JOIN functions to_f ON to_f.id = c.to_function_id
             WHERE from_f.file_id = ?`,
          )
          .all(caller),
      ).toEqual([{ dynamic: 0, fromName: 'caller', toName: 'callee' }]);
    });
  });
});
