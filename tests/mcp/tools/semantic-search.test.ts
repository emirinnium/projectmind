import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { initDatabase, closeDatabase } from '../../../src/storage/database.js';
import { semanticSearchForTool } from '../../../src/mcp/tools/semantic-search.js';
import type { McpDependencies } from '../../../src/mcp/tools/types.js';

/**
 * Deterministic embedding generator: always returns the same unit vector for
 * the query, so cosine similarity against a file seeded with that same vector
 * is exactly 1.0 (well above the default 0.7 threshold) and against an
 * orthogonal vector is 0.0 (below threshold). No real embedding provider or
 * network is touched.
 */
const QUERY_VECTOR = [1, 0, 0];
const mockEmbeddingGenerator = async (): Promise<number[]> => QUERY_VECTOR;

/** Encode a number[] as the compact Float32 BLOB the files table stores. */
function encodeEmbedding(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

/**
 * Seed a project (root_path = projectRoot) with two files:
 *  - `src/target.ts` whose embedding equals the query vector (cosine 1.0)
 *  - `src/distractor.ts` whose embedding is orthogonal (cosine 0.0)
 */
function seed(db: DatabaseSync, projectRoot: string): void {
  db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run(
    'test-project',
    projectRoot,
  );

  const insertFile = db.prepare(
    'INSERT INTO files (project_id, path, relative_path, language, size_bytes, hash, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insertFile.run(
    1,
    '/test/src/target.ts',
    'src/target.ts',
    'typescript',
    10,
    'h-target',
    encodeEmbedding(QUERY_VECTOR),
  );
  insertFile.run(
    1,
    '/test/src/distractor.ts',
    'src/distractor.ts',
    'typescript',
    10,
    'h-distractor',
    encodeEmbedding([0, 1, 0]),
  );
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    'embedding_index_config:1',
    JSON.stringify({
      requestedProvider: 'simple',
      activeProvider: 'simple',
      dimension: 3,
      effectiveDimensions: [3],
      openaiModel: 'text-embedding-3-small',
      transformersModel: 'Xenova/all-MiniLM-L6-v2',
      unixcoderModelPath: 'models/unixcoder-base.onnx',
      codebertModelPath: 'models/codebert-base.onnx',
    }),
  );
}

describe('semantic_search (semanticSearchForTool)', () => {
  let db: DatabaseSync;
  let deps: McpDependencies;
  const projectRoot = '/test';

  beforeAll(() => {
    // initDatabase(':memory:') installs the singleton connection and runs the
    // schema migrations, so the raw-SQL seeding below works.
    db = initDatabase(':memory:');
    seed(db, projectRoot);
    deps = {
      db,
      projectRoot,
      kg: { getFileByPath: () => null },
    } as unknown as McpDependencies;
  });

  afterAll(() => {
    closeDatabase();
  });

  it('returns the file whose embedding matches the query above the default threshold', async () => {
    const result = await semanticSearchForTool(
      deps,
      { query: 'rate limiting' },
      mockEmbeddingGenerator,
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      filePath: 'src/target.ts',
      score: 1,
      indexEvidence: {
        hash: 'h-target',
        embeddingDimension: 3,
      },
    });
    expect(result.query).toMatchObject({ provider: 'simple', dimension: 3 });
    expect(result.index).toMatchObject({
      scope: 'file',
      candidateFiles: 2,
      indexedFiles: 2,
      candidateItems: 2,
      indexedItems: 2,
      invalidEmbeddings: 0,
      dimensions: [3],
      compatibleFiles: 2,
      incompatibleFiles: 0,
      compatibleItems: 2,
      incompatibleItems: 0,
      freshness: expect.objectContaining({
        status: 'partial',
        checkedFiles: 2,
        missingFiles: 2,
      }),
      configuration: expect.objectContaining({
        requestedProvider: 'simple',
        activeProvider: 'simple',
        dimension: 3,
      }),
    });
    expect(result.evidence).toEqual({
      status: 'partial',
      method: 'cosine-similarity',
      source: 'files.embedding',
    });
    expect(result.limitations[0]).toMatch(/freshness/i);
  });

  it('reports source-backed evidence only when every indexed source file is fresh', async () => {
    const root = process.cwd();
    const relativePath = 'package.json';
    const { readFile } = await import('node:fs/promises');
    const { stableHash } = await import('../../../src/utils/hash.js');
    const content = await readFile(`${root}/package.json`, 'utf8');
    const sourceHash = stableHash(content);
    const project = db
      .prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)')
      .run('fresh-project', root);
    const projectId = Number(project.lastInsertRowid);
    db.prepare(
      'INSERT INTO files (project_id, path, relative_path, language, size_bytes, hash, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      projectId,
      `${root}/package.json`,
      relativePath,
      'json',
      content.length,
      sourceHash,
      encodeEmbedding(QUERY_VECTOR),
    );
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      `embedding_index_config:${projectId}`,
      JSON.stringify({
        requestedProvider: 'simple',
        activeProvider: 'simple',
        dimension: 3,
        effectiveDimensions: [3],
        openaiModel: 'text-embedding-3-small',
        transformersModel: 'Xenova/all-MiniLM-L6-v2',
        unixcoderModelPath: 'models/unixcoder-base.onnx',
        codebertModelPath: 'models/codebert-base.onnx',
      }),
    );

    const result = await semanticSearchForTool(
      {
        db,
        projectRoot: root,
        kg: {
          getFileByPath: (path: string) =>
            path === relativePath
              ? {
                  id: 99,
                  path: `${root}/package.json`,
                  relativePath,
                  hash: sourceHash,
                  lastScanned: new Date().toISOString(),
                }
              : null,
        },
      } as unknown as McpDependencies,
      { query: 'package metadata' },
      mockEmbeddingGenerator,
    );

    expect(result.evidence.status).toBe('source-backed');
    expect(result.index.freshness).toMatchObject({
      status: 'verified',
      checkedFiles: 1,
      freshFiles: 1,
      staleFiles: 0,
    });
  });

  it('respects a custom threshold that excludes the matching file', async () => {
    const result = await semanticSearchForTool(
      deps,
      { query: 'rate limiting', threshold: 0.99 },
      mockEmbeddingGenerator,
    );

    // Cosine is exactly 1.0, so a threshold of 0.99 still includes it.
    expect(result.results).toHaveLength(1);
    expect(result.results[0].filePath).toBe('src/target.ts');
  });

  it('returns no results when the threshold is above the best score', async () => {
    const result = await semanticSearchForTool(
      deps,
      { query: 'rate limiting', threshold: 1.01 },
      mockEmbeddingGenerator,
    );

    expect(result.results).toHaveLength(0);
  });

  it('throws when the project database is not initialized', async () => {
    await expect(
      semanticSearchForTool(
        { projectRoot } as McpDependencies,
        { query: 'x' },
        mockEmbeddingGenerator,
      ),
    ).rejects.toThrow(/requires the project database/i);
  });

  it('reports malformed and incompatible stored embeddings instead of hiding them', async () => {
    db.prepare(
      'INSERT INTO files (project_id, path, relative_path, language, size_bytes, hash, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      1,
      '/test/src/wrong-dimension.ts',
      'src/wrong-dimension.ts',
      'typescript',
      10,
      'h-wrong',
      encodeEmbedding([1, 0]),
    );
    db.prepare(
      'INSERT INTO files (project_id, path, relative_path, language, size_bytes, hash, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(1, '/test/src/broken.ts', 'src/broken.ts', 'typescript', 10, 'h-broken', '{not-json');

    const result = await semanticSearchForTool(
      deps,
      { query: 'rate limiting' },
      mockEmbeddingGenerator,
    );

    expect(result.index).toMatchObject({
      scope: 'file',
      candidateFiles: 4,
      indexedFiles: 3,
      candidateItems: 4,
      indexedItems: 3,
      invalidEmbeddings: 1,
      dimensions: [2, 3],
      compatibleFiles: 2,
      incompatibleFiles: 1,
      compatibleItems: 2,
      incompatibleItems: 1,
    });
    expect(result.evidence.status).toBe('partial');
    expect(result.limitations.some((item) => /unreadable|non-finite/i.test(item))).toBe(true);
    expect(result.limitations.some((item) => /different vector dimension/i.test(item))).toBe(true);
    expect(result.results.every((hit) => hit.filePath !== 'src/wrong-dimension.ts')).toBe(true);
  });

  it('supports function/class retrieval with source locations and mixed-index evidence', async () => {
    db.prepare(
      'INSERT INTO functions (file_id, name, signature, start_line, end_line, embedding) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(1, 'rateLimit', 'function rateLimit(): void', 4, 12, JSON.stringify(QUERY_VECTOR));
    db.prepare(
      'INSERT INTO classes (file_id, name, signature, start_line, end_line, embedding) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(1, 'Limiter', 'class Limiter', 20, 40, JSON.stringify(QUERY_VECTOR));

    const result = await semanticSearchForTool(
      deps,
      { query: 'rate limiting', scope: 'symbol' },
      mockEmbeddingGenerator,
    );

    expect(result.results).toHaveLength(2);
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: 'src/target.ts',
          kind: 'function',
          symbolName: 'rateLimit',
          startLine: 4,
          endLine: 12,
          indexEvidence: expect.objectContaining({ kind: 'function', embeddingDimension: 3 }),
        }),
        expect.objectContaining({
          filePath: 'src/target.ts',
          kind: 'class',
          symbolName: 'Limiter',
          startLine: 20,
          endLine: 40,
          indexEvidence: expect.objectContaining({ kind: 'class', embeddingDimension: 3 }),
        }),
      ]),
    );
    expect(result.index).toMatchObject({
      scope: 'symbol',
      candidateFiles: 1,
      indexedFiles: 1,
      candidateItems: 2,
      indexedItems: 2,
      compatibleFiles: 1,
      incompatibleFiles: 0,
      compatibleItems: 2,
      incompatibleItems: 0,
      dimensions: [3],
    });
    expect(result.evidence.source).toBe('mixed');
  });

  it('downgrades evidence when the stored provider manifest is malformed', async () => {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
      '{not-a-provider-manifest',
      'embedding_index_config:1',
    );

    const result = await semanticSearchForTool(
      deps,
      { query: 'rate limiting' },
      mockEmbeddingGenerator,
    );

    expect(result.evidence.status).toBe('partial');
    expect(result.index.configuration).toBeNull();
    expect(result.limitations.some((item) => /provider manifest|re-scan/i.test(item))).toBe(true);
  });
});
