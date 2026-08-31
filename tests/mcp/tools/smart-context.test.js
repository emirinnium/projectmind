import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/storage/database.js';
import { KnowledgeGraph } from '../../../src/storage/kg/graph.js';
import { suggestNextFilesForTool } from '../../../src/mcp/tools/smart-context.js';
/** Encode a number[] as the compact Float32 BLOB the files table stores. */
function encodeEmbedding(values) {
    return Buffer.from(new Float32Array(values).buffer);
}
/**
 * Seed a knowledge graph where `src/y.ts`, `src/z.ts` and `src/rate-limit.ts`
 * all IMPORT `src/x.ts` (the target).
 *
 * The Smart Context Assembler ranks DEPENDENTS of the target — files that
 * import it — so the import direction is deliberately the reverse of "x
 * imports y/z": the engine answers "if I edit x.ts, which files should I look
 * at next?". All three importers are therefore direct dependents of x.ts.
 *
 * All four files share the same embedding vector so the semantic-neighbor
 * signal is deterministic (cosine 1.0) and adds a 'semantically-similar'
 * reason on top of the structural 'direct-dependent' reason. The task string
 * "add rate limiting" lexically matches `src/rate-limit.ts` ('rate'), giving
 * it a deterministic task-keyword boost that lifts it to rank #1.
 *
 * Rows are inserted with raw SQL (mirroring tests/mcp/tools/merge-risk.test.ts)
 * so the test never depends on the embedding/vec-index machinery that
 * `upsertFile` would pull in.
 */
function seedDependents(db) {
    const insertFile = db.prepare('INSERT INTO files (project_id, path, relative_path, language, size_bytes, hash, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const emb = encodeEmbedding([1, 0, 0]);
    insertFile.run(1, '/test/src/x.ts', 'src/x.ts', 'typescript', 10, 'h-x', emb);
    insertFile.run(1, '/test/src/y.ts', 'src/y.ts', 'typescript', 10, 'h-y', emb);
    insertFile.run(1, '/test/src/z.ts', 'src/z.ts', 'typescript', 10, 'h-z', emb);
    insertFile.run(1, '/test/src/rate-limit.ts', 'src/rate-limit.ts', 'typescript', 10, 'h-rate', emb);
    const fileId = (relativePath) => db.prepare('SELECT id FROM files WHERE relative_path = ?').get(relativePath).id;
    const insertImport = db.prepare('INSERT INTO imports (file_id, source, kind, resolved, resolved_path) VALUES (?, ?, ?, ?, ?)');
    insertImport.run(fileId('src/y.ts'), './x', 'relative', 1, 'src/x.ts');
    insertImport.run(fileId('src/z.ts'), './x', 'relative', 1, 'src/x.ts');
    insertImport.run(fileId('src/rate-limit.ts'), './x', 'relative', 1, 'src/x.ts');
}
describe('suggest_next_files (suggestNextFilesForTool)', () => {
    let kg;
    let db;
    let deps;
    beforeAll(() => {
        // initDatabase(':memory:') installs the singleton connection that the KG
        // helper functions reach through getStatement()/getDatabase(), so the
        // graph traversal and file lookups always operate on this same DB.
        db = initDatabase(':memory:');
        kg = new KnowledgeGraph(db);
        seedDependents(db);
        deps = { kg };
    });
    afterAll(() => {
        closeDatabase();
    });
    it('ranks the dependents of the target, descending by score, each with reasons', () => {
        const result = suggestNextFilesForTool(deps, {
            relativePath: 'src/x.ts',
            task: 'add rate limiting',
            limit: 3,
        });
        // All three importers of src/x.ts are suggested.
        expect(result.items.map((i) => i.path).sort()).toEqual(['src/rate-limit.ts', 'src/y.ts', 'src/z.ts']);
        // Ranked descending by score (ties broken by path).
        for (let i = 1; i < result.items.length; i++) {
            expect(result.items[i - 1].score).toBeGreaterThanOrEqual(result.items[i].score);
        }
        // Every item carries at least one structural reason.
        for (const item of result.items) {
            expect(item.reasons.length).toBeGreaterThan(0);
            expect(item.reasons).toContain('direct-dependent');
        }
        // The task-keyword boost deterministically lifts the matching file to #1.
        expect(result.items[0].path).toBe('src/rate-limit.ts');
        expect(result.items[0].reasons).toContain('task-keyword:1');
        // consideredFiles counts the structural blast radius (3) plus any
        // semantic matches — always a number, never below the structural count.
        expect(typeof result.consideredFiles).toBe('number');
        expect(result.consideredFiles).toBeGreaterThanOrEqual(3);
        expect(result.task).toBe('add rate limiting');
    });
    it('resolves the target by fileId identically to relativePath', () => {
        const xId = db.prepare('SELECT id FROM files WHERE relative_path = ?').get('src/x.ts').id;
        const byPath = suggestNextFilesForTool(deps, { relativePath: 'src/x.ts', limit: 3 });
        const byId = suggestNextFilesForTool(deps, { fileId: String(xId), limit: 3 });
        expect(byId.items).toEqual(byPath.items);
        expect(byId.consideredFiles).toBe(byPath.consideredFiles);
    });
    it('throws a clear error when the target file is not in the knowledge graph', () => {
        expect(() => suggestNextFilesForTool(deps, { relativePath: 'src/missing.ts' })).toThrow(/not found/i);
    });
    it('throws when neither relativePath nor fileId is provided', () => {
        expect(() => suggestNextFilesForTool(deps, {})).toThrow(/relativePath or fileId/i);
    });
});
//# sourceMappingURL=smart-context.test.js.map