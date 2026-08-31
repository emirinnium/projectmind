import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { KnowledgeGraph } from '@/storage/kg/graph.js';
import { initDatabase, closeDatabase } from '@/storage/database.js';
// Mock FileStructure
const mockFileStruct = {
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
function makeFileInfo(overrides) {
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
    let kg;
    let db;
    beforeAll(() => {
        // Temp in-memory DB. initDatabase sets the singleton that the kg helper
        // functions reach through getStatement()/getDatabase(), so the graph and
        // its helpers always operate on the same connection.
        db = initDatabase(':memory:');
        // Create minimal deps for testing
        const mockDeps = {
            fs: {
                readFile: async () => 'mock content',
                // Fresh mtime so syncIncremental treats files as changed.
                stat: async () => ({ mtime: new Date() }),
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
            kg.getFileByPath = (() => fileInfo);
            const result = await kg.syncIncremental(['/mock/path/file.ts']);
            expect(result.syncedFiles).toBe(1);
            expect(result.errors).toEqual([]);
            // Restore
            kg.getFileByPath = originalGetFileByPath;
        });
    });
    describe('searchSemantic', () => {
        it('should find similar files and content', async () => {
            const fileInfo = makeFileInfo({ id: 1 });
            // searchSemantic delegates similarity lookup to findSimilarFiles —
            // mock that seam so the test never depends on the vec index or DB rows.
            const origFindSimilarFiles = kg.findSimilarFiles.bind(kg);
            kg.findSimilarFiles = (() => [fileInfo]);
            const result = await kg.searchSemantic('test query');
            expect(result.files.length).toBe(1);
            expect(result.matches.length).toBe(1);
            // Restore
            kg.findSimilarFiles = origFindSimilarFiles;
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
            kg.getMemory = (() => mockMemories);
            // Mock KG methods that replayAgentActions calls internally
            const origUpsert = kg.upsertFile.bind(kg);
            kg.upsertFile = (async () => 42);
            const origStoreDetails = kg.storeFileDetails.bind(kg);
            kg.storeFileDetails = (() => { });
            const origMarkTouched = kg.markAgentTouched.bind(kg);
            kg.markAgentTouched = (() => { });
            const result = await kg.replayAgentActions('test-agent');
            expect(result.success).toBe(true);
            expect(result.actions.length).toBe(1);
            expect(result.actions[0].action).toBe('edit');
            expect(result.errors).toEqual([]);
            // Restore
            kg.getMemory = origGetMemory;
            kg.upsertFile = origUpsert;
            kg.storeFileDetails = origStoreDetails;
            kg.markAgentTouched = origMarkTouched;
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
            kg.getMemory = (() => mockMemories);
            const origGetFileByPath = kg.getFileByPath.bind(kg);
            kg.getFileByPath = (() => makeFileInfo({ id: 99, path: '/mock/path/deleted.ts' }));
            const result = await kg.replayAgentActions('test-agent');
            expect(result.success).toBe(true);
            expect(result.actions.length).toBe(1);
            expect(result.actions[0].action).toBe('delete');
            expect(result.errors).toEqual([]);
            // Restore
            kg.getMemory = origGetMemory;
            kg.getFileByPath = origGetFileByPath;
        });
    });
});
//# sourceMappingURL=kg-graph.test.js.map