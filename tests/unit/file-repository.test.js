import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { FileRepository } from '../../src/storage/repositories/file-repository.js';
function createTestDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    return db;
}
describe('FileRepository', () => {
    let db;
    let repo;
    beforeEach(() => {
        db = createTestDb();
        db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(1, 'default', '/test');
        repo = new FileRepository(db);
    });
    describe('upsert', () => {
        it('inserts a new file', () => {
            const fileId = repo.upsert('/test/src/index.ts', {
                relativePath: 'src/index.ts',
                language: 'typescript',
                sizeBytes: 1024,
                hash: 'abc123',
                embedding: null,
                cognitiveLoad: 0.5,
            }, 1);
            expect(fileId).toBe(1);
            const file = repo.getById(fileId, 1);
            expect(file).not.toBeNull();
            expect(file.path).toBe('/test/src/index.ts');
            expect(file.language).toBe('typescript');
        });
        it('updates an existing file', () => {
            repo.upsert('/test/file.ts', {
                relativePath: 'file.ts',
                language: 'typescript',
                sizeBytes: 100,
                hash: 'hash1',
                embedding: null,
                cognitiveLoad: 0.3,
            }, 1);
            const fileId = repo.upsert('/test/file.ts', {
                relativePath: 'file.ts',
                language: 'typescript',
                sizeBytes: 200,
                hash: 'hash2',
                embedding: null,
                cognitiveLoad: 0.5,
            }, 1);
            const file = repo.getById(fileId, 1);
            expect(file.sizeBytes).toBe(200);
            expect(file.hash).toBe('hash2');
        });
    });
    describe('getByPath', () => {
        it('finds a file by path', () => {
            repo.upsert('/test/src/utils.ts', {
                relativePath: 'src/utils.ts',
                language: 'typescript',
                sizeBytes: 500,
                hash: 'util-hash',
                embedding: null,
                cognitiveLoad: 0.2,
            }, 1);
            const file = repo.getByPath('/test/src/utils.ts', 1);
            expect(file).not.toBeNull();
            expect(file.relativePath).toBe('src/utils.ts');
        });
        it('finds a file by relative path', () => {
            repo.upsert('/test/src/app.ts', {
                relativePath: 'src/app.ts',
                language: 'typescript',
                sizeBytes: 800,
                hash: 'app-hash',
                embedding: null,
                cognitiveLoad: 0.4,
            }, 1);
            const file = repo.getByPath('src/app.ts', 1);
            expect(file).not.toBeNull();
            expect(file.path).toBe('/test/src/app.ts');
        });
        it('returns null for non-existent path', () => {
            const file = repo.getByPath('/nonexistent/file.ts', 1);
            expect(file).toBeNull();
        });
    });
    describe('getAll', () => {
        it('returns all files for a project', () => {
            repo.upsert('/test/a.ts', {
                relativePath: 'a.ts',
                language: 'typescript',
                sizeBytes: 100,
                hash: 'a-hash',
                embedding: null,
                cognitiveLoad: 0.1,
            }, 1);
            repo.upsert('/test/b.ts', {
                relativePath: 'b.ts',
                language: 'typescript',
                sizeBytes: 200,
                hash: 'b-hash',
                embedding: null,
                cognitiveLoad: 0.2,
            }, 1);
            const files = repo.getAll(1);
            expect(files).toHaveLength(2);
        });
    });
    describe('getByLanguage', () => {
        it('filters files by language', () => {
            repo.upsert('/test/file.ts', {
                relativePath: 'file.ts',
                language: 'typescript',
                sizeBytes: 100,
                hash: 'ts-hash',
                embedding: null,
                cognitiveLoad: 0.1,
            }, 1);
            repo.upsert('/test/script.py', {
                relativePath: 'script.py',
                language: 'python',
                sizeBytes: 200,
                hash: 'py-hash',
                embedding: null,
                cognitiveLoad: 0.2,
            }, 1);
            const tsFiles = repo.getByLanguage('typescript', 1);
            expect(tsFiles).toHaveLength(1);
            expect(tsFiles[0].language).toBe('typescript');
        });
    });
    describe('markAgentTouched', () => {
        it('marks a file as agent-touched', () => {
            repo.upsert('/test/touched.ts', {
                relativePath: 'touched.ts',
                language: 'typescript',
                sizeBytes: 100,
                hash: 'touch-hash',
                embedding: null,
                cognitiveLoad: 0.1,
            }, 1);
            repo.markAgentTouched('/test/touched.ts', 'test-agent', 1);
            const file = repo.getByPath('/test/touched.ts', 1);
            expect(file.agentTouched).toBe(true);
            expect(file.agentTouchedBy).toBe('test-agent');
        });
    });
    describe('getAgentTouched', () => {
        it('returns files touched by a specific agent', () => {
            repo.upsert('/test/file1.ts', {
                relativePath: 'file1.ts',
                language: 'typescript',
                sizeBytes: 100,
                hash: 'hash1',
                embedding: null,
                cognitiveLoad: 0.1,
            }, 1);
            repo.upsert('/test/file2.ts', {
                relativePath: 'file2.ts',
                language: 'typescript',
                sizeBytes: 100,
                hash: 'hash2',
                embedding: null,
                cognitiveLoad: 0.1,
            }, 1);
            repo.markAgentTouched('/test/file1.ts', 'agent-a', 1);
            repo.markAgentTouched('/test/file2.ts', 'agent-b', 1);
            const agentAFiles = repo.getAgentTouched('agent-a', 1);
            expect(agentAFiles).toHaveLength(1);
            expect(agentAFiles[0].relativePath).toBe('file1.ts');
        });
        it('returns all agent-touched files when no agent specified', () => {
            repo.upsert('/test/file1.ts', {
                relativePath: 'file1.ts',
                language: 'typescript',
                sizeBytes: 100,
                hash: 'hash1',
                embedding: null,
                cognitiveLoad: 0.1,
            }, 1);
            repo.markAgentTouched('/test/file1.ts', 'agent-a', 1);
            const allTouched = repo.getAgentTouched(undefined, 1);
            expect(allTouched).toHaveLength(1);
        });
    });
    describe('getEmbedding', () => {
        it('returns null when no embedding exists', () => {
            repo.upsert('/test/file.ts', {
                relativePath: 'file.ts',
                language: 'typescript',
                sizeBytes: 100,
                hash: 'hash',
                embedding: null,
                cognitiveLoad: 0.1,
            }, 1);
            const embedding = repo.getEmbedding(1);
            expect(embedding).toBeNull();
        });
        it('retrieves stored embedding', () => {
            const embedding = [0.1, 0.2, 0.3];
            db.prepare('INSERT INTO files (project_id, path, relative_path, embedding) VALUES (?, ?, ?, ?)')
                .run(1, '/test/file.ts', 'file.ts', JSON.stringify(embedding));
            const result = repo.getEmbedding(1);
            expect(result).toEqual(embedding);
        });
    });
    describe('getAllEmbeddings', () => {
        it('returns map of all embeddings', () => {
            const emb1 = [0.1, 0.2];
            const emb2 = [0.3, 0.4];
            db.prepare('INSERT INTO files (project_id, path, relative_path, embedding) VALUES (?, ?, ?, ?)')
                .run(1, '/test/a.ts', 'a.ts', JSON.stringify(emb1));
            db.prepare('INSERT INTO files (project_id, path, relative_path, embedding) VALUES (?, ?, ?, ?)')
                .run(1, '/test/b.ts', 'b.ts', JSON.stringify(emb2));
            const embeddings = repo.getAllEmbeddings(1);
            expect(embeddings.size).toBe(2);
            expect(embeddings.get(1)).toEqual(emb1);
            expect(embeddings.get(2)).toEqual(emb2);
        });
    });
});
//# sourceMappingURL=file-repository.test.js.map