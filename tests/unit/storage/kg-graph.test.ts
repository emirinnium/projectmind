import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { KnowledgeGraph } from '@/storage/kg/graph.js';
import type { KnowledgeGraphDeps } from '@/storage/kg/graph.js';
import { initDatabase, closeDatabase } from '@/storage/database.js';
import { findSimilarFiles } from '@/storage/kg/helpers/file-similarity.js';
import { encodeEmbedding } from '@/core/embeddings/embedding-codec.js';
import type { FileStructure } from '@/parser/ast-parser.js';
import type { FileInfo, MemoryEntry } from '@/storage/kg/types.js';
import { stableHash } from '@/utils/hash.js';

// Mock FileStructure
const mockFileStruct: FileStructure = {
  filePath: '/mock/path/file.ts',
  language: 'typescript',
  sizeBytes: 100,
  hash: 'abc',
  imports: [],
  functions: [],
  classes: [],
  exports: [],
  lines: 100,
};

// Helper: create a full FileInfo object
function makeFileInfo(overrides: Partial<FileInfo>): FileInfo {
  return {
    id: 1,
    path: '/mock/path/file.ts',
    relativePath: 'file.ts',
    language: 'typescript',
    sizeBytes: 100,
    hash: 'abc',
    agentTouched: false,
    agentTouchedBy: null,
    agentTouchedAt: null,
    cognitiveLoad: 0,
    lastScanned: new Date().toISOString(),
    lastSynced: new Date().toISOString(),
    patterns: [],
    ...overrides,
  };
}

describe('KnowledgeGraph', () => {
  let kg: KnowledgeGraph;
  let db: DatabaseSync;
  let readFileCalls = 0;
  let realpathImpl: ((path: string) => Promise<string>) | undefined;

  beforeAll(() => {
    // Temp in-memory DB. initDatabase sets the singleton that the kg helper
    // functions reach through getStatement()/getDatabase(), so the graph and
    // its helpers always operate on the same connection.
    db = initDatabase(':memory:');

    // Create minimal deps for testing
    const mockDeps: KnowledgeGraphDeps = {
      fs: {
        readFile: async () => {
          readFileCalls++;
          return 'mock content';
        },
        // The sync path intentionally compares content hashes, not mtime.
        stat: async () => ({ mtime: new Date() }),
        realpath: async (path) => (realpathImpl ? realpathImpl(path) : path),
      },
      parser: {
        parseFile: () => mockFileStruct,
      },
      embedding: {
        generateEmbedding: async () => Array(768).fill(0.1),
        cosineSimilarity: () => 0.9,
      },
    };

    kg = new KnowledgeGraph(db, mockDeps);
  });

  afterAll(() => {
    closeDatabase();
  });

  describe('syncIncremental', () => {
    it('should sync changed files', async () => {
      // Put the mock file inside the active project's root so the
      // project-membership check passes.
      const project = kg.createProject('mock-project', '/mock');
      kg.switchProject(project.id);

      const fileInfo = makeFileInfo({
        id: 1,
        path: '/mock/path/file.ts',
        lastSynced: new Date(Date.now() - 10000).toISOString(),
      });

      // Mock getFileByPath
      const originalGetFileByPath = kg.getFileByPath.bind(kg);
      kg.getFileByPath = (() => fileInfo) as typeof originalGetFileByPath;

      const result = await kg.syncIncremental(['/mock/path/file.ts']);
      expect(result.syncedFiles).toBe(1);
      expect(result.errors).toEqual([]);

      // Restore
      kg.getFileByPath = originalGetFileByPath;
    });

    it('does not rewrite an unchanged file even when its sync timestamp is old', async () => {
      const project = kg.getCurrentProject();
      expect(project).not.toBeNull();
      const fileInfo = makeFileInfo({
        path: '/mock/path/file.ts',
        hash: stableHash('mock content'),
        lastSynced: new Date(Date.now() - 10000).toISOString(),
      });
      const originalGetFileByPath = kg.getFileByPath.bind(kg);
      kg.getFileByPath = (() => fileInfo) as typeof originalGetFileByPath;

      const result = await kg.syncIncremental(['/mock/path/file.ts']);
      expect(result.syncedFiles).toBe(0);
      expect(result.errors).toEqual([]);

      kg.getFileByPath = originalGetFileByPath;
    });

    it('should reject a path that only shares the project root prefix', async () => {
      const originalGetFileByPath = kg.getFileByPath.bind(kg);
      let lookupCalled = false;
      kg.getFileByPath = (() => {
        lookupCalled = true;
        return makeFileInfo({ path: '/mock-evil/path/file.ts' });
      }) as typeof originalGetFileByPath;

      const result = await kg.syncIncremental(['/mock-evil/path/file.ts']);

      expect(result.syncedFiles).toBe(0);
      expect(result.errors).toEqual([
        'File /mock-evil/path/file.ts is not part of the current project',
      ]);
      expect(lookupCalled).toBe(false);

      kg.getFileByPath = originalGetFileByPath;
    });
  });

  describe('searchSemantic', () => {
    it('should find similar files and content', async () => {
      const fileInfo = makeFileInfo({ id: 1 });

      // searchSemantic delegates similarity lookup to findSimilarFiles —
      // mock that seam so the test never depends on the vec index or DB rows.
      const origFindSimilarFiles = kg.findSimilarFiles.bind(kg);
      kg.findSimilarFiles = (() => [fileInfo]) as typeof origFindSimilarFiles;

      const result = await kg.searchSemantic('test query');
      expect(result.files.length).toBe(1);
      expect(result.matches.length).toBe(1);

      // Restore
      kg.findSimilarFiles = origFindSimilarFiles;
    });

    it('preserves similarity ranking when SQLite returns IN rows in another order', () => {
      const previousProject = kg.getCurrentProject();
      const project = kg.createProject('similarity-order-project', '/similarity-order');
      try {
        kg.switchProject(project.id);

        const insert = db.prepare(
          `INSERT INTO files
            (path, relative_path, language, size_bytes, hash, embedding, project_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        const files = [
          { path: '/similarity-order/first.ts', embedding: [0.8, 0.6, 0] },
          { path: '/similarity-order/second.ts', embedding: [0.7, 0.7, 0] },
          { path: '/similarity-order/third.ts', embedding: [0.9, 0.435889894, 0] },
        ];
        const ids = files.map((file, index) => {
          const result = insert.run(
            file.path,
            `file-${index}.ts`,
            'typescript',
            10,
            `hash-${index}`,
            encodeEmbedding(file.embedding),
            project.id,
          ) as { lastInsertRowid: number | bigint };
          return Number(result.lastInsertRowid);
        });

        const result = findSimilarFiles(
          { db, currentProjectId: project.id, projectRoot: project.rootPath },
          [1, 0, 0],
          0.5,
          3,
        );

        expect(result.map((file) => file.id)).toEqual([ids[2], ids[0], ids[1]]);
      } finally {
        if (previousProject) kg.switchProject(previousProject.id);
      }
    });
  });

  describe('replayAgentActions', () => {
    it('should replay agent actions (edit)', async () => {
      const mockMemories: MemoryEntry[] = [
        {
          id: 1,
          sessionId: 1,
          scope: 'agent_actions',
          key: 'session_test-agent',
          value: JSON.stringify({
            action: 'edit',
            filePath: '/mock/path/file.ts',
            details: 'test edit',
          }),
          createdAt: new Date().toISOString(),
        },
      ];

      // Mock getMemory
      const origGetMemory = kg.getMemory.bind(kg);
      kg.getMemory = (() => mockMemories) as typeof origGetMemory;

      // Mock KG methods that replayAgentActions calls internally
      const origUpsert = kg.upsertFile.bind(kg);
      kg.upsertFile = (async () => 42) as unknown as typeof origUpsert;
      const origStoreDetails = kg.storeFileDetails.bind(kg);
      kg.storeFileDetails = (() => undefined) as unknown as typeof origStoreDetails;
      const origMarkTouched = kg.markAgentTouched.bind(kg);
      kg.markAgentTouched = (() => undefined) as unknown as typeof origMarkTouched;

      const result = await kg.replayAgentActions('test-agent');
      expect(result.success).toBe(true);
      expect(result.actions.length).toBe(1);
      expect(result.actions[0]!.action).toBe('edit');
      expect(result.errors).toEqual([]);

      // Restore
      kg.getMemory = origGetMemory;
      kg.upsertFile = origUpsert;
      kg.storeFileDetails = origStoreDetails;
      kg.markAgentTouched = origMarkTouched;
    });

    it('should reject persisted actions outside the active project', async () => {
      const mockMemories: MemoryEntry[] = [
        {
          id: 3,
          sessionId: 1,
          scope: 'agent_actions',
          key: 'session_test-agent',
          value: JSON.stringify({
            action: 'edit',
            filePath: '../outside.ts',
            details: 'must not be replayed',
          }),
          createdAt: new Date().toISOString(),
        },
      ];

      const origGetMemory = kg.getMemory.bind(kg);
      kg.getMemory = (() => mockMemories) as typeof origGetMemory;
      const origUpsert = kg.upsertFile.bind(kg);
      let upsertCalled = false;
      kg.upsertFile = (async () => {
        upsertCalled = true;
        return 42;
      }) as unknown as typeof origUpsert;
      const readsBefore = readFileCalls;

      const result = await kg.replayAgentActions('test-agent');

      expect(result.success).toBe(false);
      expect(result.actions).toEqual([]);
      expect(result.errors).toEqual(['File ../outside.ts is not part of the current project']);
      expect(readFileCalls).toBe(readsBefore);
      expect(upsertCalled).toBe(false);

      kg.getMemory = origGetMemory;
      kg.upsertFile = origUpsert;
    });

    it('should reject persisted actions that escape through a symlink', async () => {
      const mockMemories: MemoryEntry[] = [
        {
          id: 4,
          sessionId: 1,
          scope: 'agent_actions',
          key: 'session_test-agent',
          value: JSON.stringify({
            action: 'edit',
            filePath: 'link/secret.ts',
            details: 'must not follow an external symlink',
          }),
          createdAt: new Date().toISOString(),
        },
      ];

      const origGetMemory = kg.getMemory.bind(kg);
      kg.getMemory = (() => mockMemories) as typeof origGetMemory;
      const origUpsert = kg.upsertFile.bind(kg);
      let upsertCalled = false;
      kg.upsertFile = (async () => {
        upsertCalled = true;
        return 42;
      }) as unknown as typeof origUpsert;
      realpathImpl = async (path) =>
        path.replace(/\\/g, '/').includes('/mock/link/') ? '/outside/secret.ts' : path;

      const result = await kg.replayAgentActions('test-agent');

      expect(result.success).toBe(false);
      expect(result.actions).toEqual([]);
      expect(result.errors).toEqual(['File link/secret.ts is not part of the current project']);
      expect(upsertCalled).toBe(false);

      realpathImpl = undefined;
      kg.getMemory = origGetMemory;
      kg.upsertFile = origUpsert;
    });

    it('should replay agent actions (delete)', async () => {
      const mockMemories: MemoryEntry[] = [
        {
          id: 2,
          sessionId: 1,
          scope: 'agent_actions',
          key: 'session_test-agent',
          value: JSON.stringify({
            action: 'delete',
            filePath: '/mock/path/deleted.ts',
            details: 'removed file',
          }),
          createdAt: new Date().toISOString(),
        },
      ];

      const origGetMemory = kg.getMemory.bind(kg);
      kg.getMemory = (() => mockMemories) as typeof origGetMemory;

      const origGetFileByPath = kg.getFileByPath.bind(kg);
      kg.getFileByPath = (() =>
        makeFileInfo({ id: 99, path: '/mock/path/deleted.ts' })) as typeof origGetFileByPath;

      const result = await kg.replayAgentActions('test-agent');
      expect(result.success).toBe(true);
      expect(result.actions.length).toBe(1);
      expect(result.actions[0]!.action).toBe('delete');
      expect(result.errors).toEqual([]);

      // Restore
      kg.getMemory = origGetMemory;
      kg.getFileByPath = origGetFileByPath;
    });

    it('should not delete a database row whose stored path is outside the project', async () => {
      const mockMemories: MemoryEntry[] = [
        {
          id: 5,
          sessionId: 1,
          scope: 'agent_actions',
          key: 'session_test-agent',
          value: JSON.stringify({
            action: 'delete',
            filePath: '/mock/path/deleted.ts',
            details: 'stored row must also be checked',
          }),
          createdAt: new Date().toISOString(),
        },
      ];

      const origGetMemory = kg.getMemory.bind(kg);
      kg.getMemory = (() => mockMemories) as typeof origGetMemory;
      const origGetFileByPath = kg.getFileByPath.bind(kg);
      kg.getFileByPath = (() =>
        makeFileInfo({ id: 100, path: '/mock-evil/deleted.ts' })) as typeof origGetFileByPath;

      const result = await kg.replayAgentActions('test-agent');

      expect(result.success).toBe(false);
      expect(result.actions).toEqual([]);
      expect(result.errors).toEqual([
        'Stored file /mock-evil/deleted.ts is not part of the current project',
      ]);

      kg.getMemory = origGetMemory;
      kg.getFileByPath = origGetFileByPath;
    });
  });
});
