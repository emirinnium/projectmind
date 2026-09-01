import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// VectorIndex – simple in-memory cosine-similarity index
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must be of the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Simple in-memory vector index using cosine similarity.
 */
export class VectorIndex {
  private vectors: Map<string, number[]> = new Map();
  private metadata: Map<string, Record<string, string | number | boolean | null>> = new Map();

  /**
   * Add a vector to the index.
   */
  addVector(
    id: string,
    vector: number[],
    metadata: Record<string, string | number | boolean | null> = {},
  ): void {
    this.vectors.set(id, vector);
    this.metadata.set(id, metadata);
  }

  /**
   * Find similar vectors.
   */
  findSimilar(
    queryVector: number[],
    limit: number = 5,
  ): Array<{
    id: string;
    score: number;
    metadata: Record<string, string | number | boolean | null>;
  }> {
    const results: Array<{
      id: string;
      score: number;
      metadata: Record<string, string | number | boolean | null>;
    }> = [];

    for (const [id, vector] of this.vectors) {
      const score = cosineSimilarity(queryVector, vector);
      results.push({
        id,
        score,
        metadata: this.metadata.get(id) || {},
      });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Clear the index.
   */
  clear(): void {
    this.vectors.clear();
    this.metadata.clear();
  }
}

// ---------------------------------------------------------------------------
// VecIndex – persistent sqlite-vec backed vector index (ANN via HNSW)
//
// Uses the `sqlite-vec` WASM/native extension to store embeddings in a
// virtual table (`pm_vec_files`) and perform sub-millisecond approximate
// nearest-neighbor search via `MATCH`.
//
// When the extension cannot be loaded (e.g. unsupported platform, missing
// native binary, or older DB files), every method silently degrades so the
// caller can fall back to full-table scan.
// ---------------------------------------------------------------------------

const VEC_TABLE_NAME = 'pm_vec_files';
const DEFAULT_DIMENSION = 768;

/**
 * ESM-safe `require`. A bare `require()` is undefined under `"type": "module"`,
 * which previously threw a `ReferenceError` that the try/catch silently
 * swallowed — leaving `isAvailable()` permanently `false` even when the
 * sqlite-vec native binary was present.
 */
const esmRequire = createRequire(import.meta.url);

/** Warn exactly once per process when sqlite-vec fails to load. */
let vecLoadWarned = false;

/** One VecIndex per DatabaseSync instance, lazily created. */
const vecIndexRegistry = new WeakMap<DatabaseSync, VecIndex>();

/**
 * Get or create the singleton VecIndex for a given database.
 * Returns a VecIndex whose `isAvailable()` may be `false` if the
 * extension failed to load — callers must check.
 */
export function getVecIndex(db: DatabaseSync): VecIndex {
  let idx = vecIndexRegistry.get(db);
  if (!idx) {
    idx = new VecIndex(db);
    vecIndexRegistry.set(db, idx);
  }
  return idx;
}

export class VecIndex {
  private readonly db: DatabaseSync;
  private readonly dim: number;
  private readonly _available: boolean;

  /**
   * @param db  An **already-opened** DatabaseSync with `allowExtension: true`.
   * @param dim Embedding dimension (default 768 – matches the project's
   *            default embedding model).
   */
  constructor(db: DatabaseSync, dim: number = DEFAULT_DIMENSION) {
    this.db = db;
    this.dim = dim;
    this._available = this.tryInit();
  }

  /** Whether sqlite-vec loaded successfully and the virtual table exists. */
  isAvailable(): boolean {
    return this._available;
  }

  // -- Write operations ----------------------------------------------------

  /**
   * Insert or update a single embedding by its row ID (files.id).
   *
   * sqlite-vec requires BigInt rowids on Node 26.
   */
  upsert(id: number, embedding: number[]): void {
    if (!this._available || embedding.length !== this.dim) return;
    try {
      const vec = new Float32Array(embedding);
      const bigId = BigInt(id);
      const upd = this.db
        .prepare(`UPDATE ${VEC_TABLE_NAME} SET embedding = ? WHERE rowid = ?`)
        .run(vec, bigId) as { changes: number };
      if (upd.changes === 0) {
        this.db
          .prepare(`INSERT INTO ${VEC_TABLE_NAME}(rowid, embedding) VALUES (?, ?)`)
          .run(bigId, vec);
      }
    } catch (e) {
      // Non-fatal – caller falls back to brute-force.
      logger.warn('VecIndex upsert failed, skipping embedding update', {
        id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Remove an embedding by ID. */
  remove(id: number): void {
    if (!this._available) return;
    try {
      this.db.prepare(`DELETE FROM ${VEC_TABLE_NAME} WHERE rowid = ?`).run(BigInt(id));
    } catch (e) {
      // Non-fatal.
      logger.warn('VecIndex remove failed, embedding may still persist', {
        id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Remove every embedding that belongs to a project (K9). The vec table
   * spans ALL projects (file IDs are globally unique), so `project delete`
   * must prune it or the orphaned vectors keep surfacing in ANN search.
   */
  removeByProject(projectId: number): void {
    if (!this._available) return;
    try {
      this.db
        .prepare(
          `DELETE FROM ${VEC_TABLE_NAME} WHERE rowid IN (SELECT id FROM files WHERE project_id = ?)`,
        )
        .run(projectId);
    } catch (e) {
      // Non-fatal.
      logger.warn('VecIndex removeByProject failed, orphaned embeddings may persist', {
        projectId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // -- Read operations -----------------------------------------------------

  /**
   * Approximate nearest-neighbour search.
   *
   * Returns results sorted by **cosine distance** (0 = identical, 2 = opposite).
   * The caller converts to similarity via `1 - distance` if needed.
   *
   * K9: when `projectId` is given, candidates are restricted to that project's
   * files (`rowid IN (SELECT id FROM files WHERE project_id = ?)`) so search
   * never leaks vectors from other projects.
   */
  findSimilar(
    queryEmbedding: number[],
    limit: number = 10,
    projectId?: number,
  ): Array<{ id: number; distance: number }> {
    if (!this._available || queryEmbedding.length !== this.dim) return [];
    try {
      const vec = new Float32Array(queryEmbedding);
      const sql =
        projectId === undefined
          ? `SELECT rowid, distance FROM ${VEC_TABLE_NAME} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
          : `SELECT rowid, distance FROM ${VEC_TABLE_NAME} WHERE embedding MATCH ? AND rowid IN (SELECT id FROM files WHERE project_id = ?) ORDER BY distance LIMIT ?`;
      const rows =
        projectId === undefined
          ? (this.db.prepare(sql).all(vec, limit) as Array<{ rowid: bigint; distance: number }>)
          : (this.db.prepare(sql).all(vec, projectId, limit) as Array<{
              rowid: bigint;
              distance: number;
            }>);
      return rows.map((r) => ({ id: Number(r.rowid), distance: r.distance }));
    } catch (e) {
      // Non-fatal — caller falls back to brute-force scan.
      logger.warn('VecIndex findSimilar failed, returning empty results', {
        ...(projectId !== undefined ? { projectId } : {}),
        limit,
        error: e instanceof Error ? e.message : String(e),
      });
      return [];
    }
  }

  // -- Bulk operations -----------------------------------------------------

  /**
   * Drop and recreate the virtual table, then populate it from the `files`
   * table.  Called after a full scan or on first init to ensure consistency.
   */
  rebuild(): void {
    if (!this._available) return;
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE_NAME}`);
      this.db.exec(
        `CREATE VIRTUAL TABLE ${VEC_TABLE_NAME} USING vec0(embedding float[${this.dim}])`,
      );

      const rows = this.db
        .prepare('SELECT id, embedding FROM files WHERE embedding IS NOT NULL')
        .all() as Array<{ id: number; embedding: Buffer | null }>;

      const ins = this.db.prepare(`INSERT INTO ${VEC_TABLE_NAME}(rowid, embedding) VALUES (?, ?)`);

      let count = 0;
      for (const row of rows) {
        if (!row.embedding) continue;
        try {
          const floats = new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            Math.floor(row.embedding.byteLength / 4),
          );
          ins.run(BigInt(row.id), new Float32Array(floats));
          count++;
        } catch (e) {
          // Skip corrupt embedding.
          logger.warn('VecIndex rebuild: skipping corrupt embedding during rebuild', {
            fileId: row.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      logger.debug(`VecIndex rebuild: indexed ${count} embeddings`);
    } catch (e) {
      logger.debug(`VecIndex rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // -- Private -------------------------------------------------------------

  /**
   * Attempt to load sqlite-vec and create the virtual table.
   * Returns `true` on success, `false` if anything fails (graceful degradation).
   */
  private tryInit(): boolean {
    try {
      // Dynamic import so the module never crashes when sqlite-vec is
      // unavailable or the native binary is missing.
      const vec = esmRequire('sqlite-vec') as { load: (db: DatabaseSync) => void };
      vec.load(this.db);

      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE_NAME} USING vec0(embedding float[${this.dim}])`,
      );
      return true;
    } catch (e) {
      // sqlite-vec unavailable or extension loading disabled – degrade.
      // Log a clear ONE-TIME warning with the real reason (previously the
      // failure was swallowed silently and callers could not tell why
      // vector search was stuck on the brute-force path).
      if (!vecLoadWarned) {
        vecLoadWarned = true;
        logger.warn(
          `sqlite-vec unavailable — vector search falls back to brute-force: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return false;
    }
  }
}
