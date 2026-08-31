import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/storage/database.js';
import { semanticSearchForTool } from '../../../src/mcp/tools/semantic-search.js';
/**
 * Deterministic embedding generator: always returns the same unit vector for
 * the query, so cosine similarity against a file seeded with that same vector
 * is exactly 1.0 (well above the default 0.7 threshold) and against an
 * orthogonal vector is 0.0 (below threshold). No real embedding provider or
 * network is touched.
 */
const QUERY_VECTOR = [1, 0, 0];
const mockEmbeddingGenerator = async () => QUERY_VECTOR;
/** Encode a number[] as the compact Float32 BLOB the files table stores. */
function encodeEmbedding(values) {
    return Buffer.from(new Float32Array(values).buffer);
}
/**
 * Seed a project (root_path = projectRoot) with two files:
 *  - `src/target.ts` whose embedding equals the query vector (cosine 1.0)
 *  - `src/distractor.ts` whose embedding is orthogonal (cosine 0.0)
 */
function seed(db, projectRoot) {
    db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run('test-project', projectRoot);
    const insertFile = db.prepare('INSERT INTO files (project_id, path, relative_path, language, size_bytes, hash, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insertFile.run(1, '/test/src/target.ts', 'src/target.ts', 'typescript', 10, 'h-target', encodeEmbedding(QUERY_VECTOR));
    insertFile.run(1, '/test/src/distractor.ts', 'src/distractor.ts', 'typescript', 10, 'h-distractor', encodeEmbedding([0, 1, 0]));
}
describe('semantic_search (semanticSearchForTool)', () => {
    let db;
    let deps;
    const projectRoot = '/test';
    beforeAll(() => {
        // initDatabase(':memory:') installs the singleton connection and runs the
        // schema migrations, so the raw-SQL seeding below works.
        db = initDatabase(':memory:');
        seed(db, projectRoot);
        deps = { db, projectRoot };
    });
    afterAll(() => {
        closeDatabase();
    });
    it('returns the file whose embedding matches the query above the default threshold', async () => {
        const result = await semanticSearchForTool(deps, { query: 'rate limiting' }, mockEmbeddingGenerator);
        expect(result.results).toHaveLength(1);
        expect(result.results[0]).toMatchObject({
            filePath: 'src/target.ts',
            score: 1,
        });
    });
    it('respects a custom threshold that excludes the matching file', async () => {
        const result = await semanticSearchForTool(deps, { query: 'rate limiting', threshold: 0.99 }, mockEmbeddingGenerator);
        // Cosine is exactly 1.0, so a threshold of 0.99 still includes it.
        expect(result.results).toHaveLength(1);
        expect(result.results[0].filePath).toBe('src/target.ts');
    });
    it('returns no results when the threshold is above the best score', async () => {
        const result = await semanticSearchForTool(deps, { query: 'rate limiting', threshold: 1.01 }, mockEmbeddingGenerator);
        expect(result.results).toHaveLength(0);
    });
    it('throws when the project database is not initialized', async () => {
        await expect(semanticSearchForTool({ projectRoot }, { query: 'x' }, mockEmbeddingGenerator)).rejects.toThrow(/requires the project database/i);
    });
});
//# sourceMappingURL=semantic-search.test.js.map