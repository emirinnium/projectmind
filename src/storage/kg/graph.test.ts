import { KnowledgeGraph } from './graph.js';
import { getDatabase } from '../database.js';
import { SCHEMA_SQL } from '../schema.js';
import type { FileStructure } from '../../parser/ast-parser.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { KnowledgeGraphDeps } from './graph.js';
import type { FileInfo } from './types.js';

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
  let db: ReturnType<typeof getDatabase>;

  beforeAll(() => {
    db = getDatabase();
    db.exec(SCHEMA_SQL);

    // Create minimal deps for testing
    const mockDeps: KnowledgeGraphDeps = {
      fs: {
        readFile: async () => 'mock content',
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
    db.close();
  });

  describe('syncIncremental', () => {
    it('should sync changed files', async () => {
      const fileInfo = makeFileInfo({
        id: 1,
        path: '/mock/path/file.ts',
        lastSynced: new Date(Date.now() - 10000).toISOString(),
      });

      // Mock getFileByPath
      const originalGetFileByPath = kg.getFileByPath.bind(kg);
      kg['getFileByPath'] = (() => fileInfo) as typeof originalGetFileByPath;

      const result = await kg.syncIncremental(['/mock/path/file.ts']);
      expect(result.syncedFiles).toBe(1);
      expect(result.errors).toEqual([]);

      // Restore
      kg['getFileByPath'] = originalGetFileByPath;
    });
  });

  describe('searchSemantic', () => {
    it('should find similar files and content', async () => {
      const fileInfo = makeFileInfo({ id: 1 });

      // Mock methods
      const origGetAllFiles = kg.getAllFiles.bind(kg);
      kg['getAllFiles'] = (() => [fileInfo]) as typeof origGetAllFiles;

      const result = await kg.searchSemantic('test query');
      expect(result.files.length).toBe(1);

      // Restore
      kg['getAllFiles'] = origGetAllFiles;
    });
  });

  describe('replayAgentActions', () => {
    it('should replay agent actions (edit)', async () => {
      const mockMemories = [{
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
      }];

      // Mock getMemory
      const origGetMemory = kg.getMemory.bind(kg);
      kg['getMemory'] = (() => mockMemories) as typeof origGetMemory;

      // Mock KG methods that replayAgentActions calls internally
      const origUpsert = kg.upsertFile.bind(kg);
      kg.upsertFile = (async () => 42) as typeof origUpsert;
kg.storeFileDetails = ((fileId: number, fileStruct: FileStructure) => Promise.resolve()) as typeof kg.storeFileDetails;
kg.markAgentTouched = ((filePath: string, agentName: string) => Promise.resolve()) as typeof kg.markAgentTouched;

      const result = await kg.replayAgentActions('test-agent');
      expect(result.success).toBe(true);
      expect(result.actions.length).toBe(1);
      expect(result.actions[0]!.action).toBe('edit');
      expect(result.errors).toEqual([]);

      // Restore
      kg['getMemory'] = origGetMemory;
      kg.upsertFile = origUpsert;
    });

    it('should replay agent actions (delete)', async () => {
      const mockMemories = [{
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
      }];

      const origGetMemory = kg.getMemory.bind(kg);
      kg['getMemory'] = (() => mockMemories) as typeof origGetMemory;

      const origGetFileByPath = kg.getFileByPath.bind(kg);
      kg.getFileByPath = (() => makeFileInfo({ id: 99, path: '/mock/path/deleted.ts' })) as typeof origGetFileByPath;

      const result = await kg.replayAgentActions('test-agent');
      expect(result.success).toBe(true);
      expect(result.actions.length).toBe(1);
      expect(result.actions[0]!.action).toBe('delete');
      expect(result.errors).toEqual([]);

      // Restore
      kg['getMemory'] = origGetMemory;
      kg.getFileByPath = origGetFileByPath;
    });
  });
});
