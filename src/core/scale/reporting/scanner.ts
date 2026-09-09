import { reportSuppressedError } from '../../../utils/errors.js';
import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../../../storage/database.js';
import { SCHEMA_SQL } from '../../../storage/schema.js';
import { KnowledgeGraph } from '../../../storage/knowledge-graph.js';
import { parseFile } from '../../../parser/ast-parser.js';
import { PatternLibrary } from '../../../parser/pattern-extractor.js';
import { decodeEmbedding } from '../../../core/embeddings/embedding-codec.js';
import fg from 'fast-glob';
import { loadConfig } from '../../../utils/config.js';
import { getProjectIgnorePatterns } from '../../../utils/ignore.js';
import { stableHash } from '../../../utils/hash.js';
import {
  getCurrentProvider,
  initializeConfiguredEmbeddingProvider,
} from '../../../parser/embeddings.js';
import {
  embeddingIndexConfigKey,
  embeddingIndexConfigurationFingerprint,
  parseEmbeddingIndexConfiguration,
  serializeEmbeddingIndexConfiguration,
  type EmbeddingIndexConfiguration,
} from '../../../core/embeddings/index-configuration.js';
import type { ScanProfile } from './types.js';

/** Files larger than this are skipped (not counted as errors). */
export const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;
/**
 * Handles project scanning with performance profiling
 */
export class ProjectScanner {
  private db: DatabaseSync;
  private kg: KnowledgeGraph;

  constructor(db?: DatabaseSync, kg?: KnowledgeGraph) {
    this.db = db ?? getDatabase();
    this.db.exec(SCHEMA_SQL);
    this.kg = kg ?? new KnowledgeGraph();
  }

  async scanProject(
    rootPath?: string,
    full?: boolean,
    signal?: AbortSignal,
  ): Promise<{ scanned: number; errors: number }> {
    const profile = await this.scanProjectWithProfile(rootPath, full, signal);
    return { scanned: profile.scannedFiles, errors: profile.errorFiles };
  }

  async scanProjectWithProfile(
    rootPath?: string,
    full?: boolean,
    signal?: AbortSignal,
  ): Promise<ScanProfile> {
    const startTime = Date.now();
    const startMemory = process.memoryUsage().heapUsed;

    const root = rootPath ?? loadConfig().projectRoot;
    await initializeConfiguredEmbeddingProvider();
    const embeddingIndexState = this.prepareEmbeddingIndexConfiguration();
    const ignorePatterns = getProjectIgnorePatterns(root);

    // Only JavaScript/TypeScript files are indexed. Keeping the scan scope
    // aligned with the parser registry prevents unsupported source trees from
    // inflating the graph or appearing as parse failures.
    const files = await fg(['**/*.{ts,tsx,js,jsx,mjs,cjs}'], {
      cwd: root,
      ignore: ignorePatterns,
      absolute: true,
    });

    this.pruneDeletedFiles(files, root);

    // Incremental scanning: only process files that have changed since last scan
    const changedFiles =
      full || embeddingIndexState.rebuildRequired
        ? files
        : await this.filterChangedFiles(files, root);

    let scanned = 0;
    let errors = 0;
    const errorDetails: string[] = [];
    const patternLib = new PatternLibrary(this.db);

    // Process files in batches for better performance
    const batchSize = 50;
    for (let i = 0; i < changedFiles.length; i += batchSize) {
      if (signal?.aborted) throw new Error('Project scan aborted');
      const batch = changedFiles.slice(i, i + batchSize);

      this.db.exec('BEGIN');
      try {
        for (const filePath of batch) {
          if (signal?.aborted) throw new Error('Project scan aborted');
          try {
            if ((await stat(filePath)).size > MAX_SCAN_FILE_BYTES) {
              continue;
            }
            const content = (await readFile(filePath, 'utf-8')).replace(/^\uFEFF/, '');
            const fileStruct = parseFile(filePath, content);
            if (!fileStruct) {
              errors++;
              errorDetails.push(`${filePath}: Parse returned null`);
              continue;
            }

            const relPath = relative(root, filePath).replace(/\\/g, '/');
            const fileId = await this.kg.upsertFile(fileStruct, relPath);
            await this.kg.storeFileDetails(fileId, fileStruct);
            // Extract patterns for genome scoring
            patternLib.extractPatterns(fileStruct);
            scanned++;
          } catch (e) {
            errors++;
            errorDetails.push(`${filePath}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        errorDetails.push(
          `Batch transaction failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        // Continue processing remaining batches instead of failing completely
      }
    }

    if (errors === 0) {
      try {
        this.persistEmbeddingIndexConfiguration(embeddingIndexState.configuration);
      } catch (e) {
        errors++;
        errorDetails.push(
          `Embedding index configuration could not be persisted: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const durationMs = Date.now() - startTime;
    const endMemory = process.memoryUsage().heapUsed;

    return {
      totalFiles: files.length,
      scannedFiles: scanned,
      errorFiles: errors,
      durationMs,
      filesPerSecond: durationMs > 0 ? Math.round(scanned / (durationMs / 1000)) : 0,
      memoryUsedMB: Math.round(((endMemory - startMemory) / 1024 / 1024) * 100) / 100,
      errors: errorDetails,
    };
  }

  /**
   * Detect provider/model/dimension changes before hash-based incremental
   * filtering. Embeddings are not comparable across configurations, even when
   * the source file hash is unchanged, so a changed manifest forces a full
   * re-embedding pass for the current project.
   */
  private prepareEmbeddingIndexConfiguration(): {
    fingerprint: string;
    rebuildRequired: boolean;
    configuration: EmbeddingIndexConfiguration;
  } {
    const embeddings = loadConfig().embeddings;
    const configuration: EmbeddingIndexConfiguration = {
      requestedProvider: embeddings.provider,
      activeProvider: getCurrentProvider(),
      dimension: embeddings.dimension,
      effectiveDimensions: [],
      openaiModel: embeddings.openaiModel,
      transformersModel: embeddings.transformersModel,
      unixcoderModelPath: embeddings.unixcoderModelPath,
      codebertModelPath: embeddings.codebertModelPath,
    };
    const fingerprint = embeddingIndexConfigurationFingerprint(configuration);
    const key = embeddingIndexConfigKey(this.kg.getCurrentProjectId());
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    const storedConfiguration = row ? parseEmbeddingIndexConfiguration(row.value) : null;
    const storedEmbeddingCount = Number(
      (
        this.db
          .prepare(
            'SELECT COUNT(*) AS count FROM files WHERE project_id = ? AND embedding IS NOT NULL',
          )
          .get(this.kg.getCurrentProjectId()) as { count: number | bigint }
      ).count,
    );

    return {
      fingerprint,
      rebuildRequired:
        storedEmbeddingCount > 0 &&
        (storedConfiguration === null ||
          embeddingIndexConfigurationFingerprint(storedConfiguration) !== fingerprint),
      configuration,
    };
  }

  private persistEmbeddingIndexConfiguration(configuration: EmbeddingIndexConfiguration): void {
    const key = embeddingIndexConfigKey(this.kg.getCurrentProjectId());
    const effectiveDimensions = this.getPersistedEmbeddingDimensions();
    this.db
      .prepare(
        'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
      )
      .run(
        key,
        serializeEmbeddingIndexConfiguration({
          ...configuration,
          effectiveDimensions,
        }),
      );
  }

  private getPersistedEmbeddingDimensions(): number[] {
    try {
      const rows = this.db
        .prepare(
          'SELECT embedding FROM files WHERE project_id = ? AND embedding IS NOT NULL ' +
            'UNION ALL ' +
            'SELECT fn.embedding FROM functions fn JOIN files f ON f.id = fn.file_id ' +
            'WHERE f.project_id = ? AND fn.embedding IS NOT NULL ' +
            'UNION ALL ' +
            'SELECT cls.embedding FROM classes cls JOIN files f ON f.id = cls.file_id ' +
            'WHERE f.project_id = ? AND cls.embedding IS NOT NULL',
        )
        .all(
          this.kg.getCurrentProjectId(),
          this.kg.getCurrentProjectId(),
          this.kg.getCurrentProjectId(),
        ) as Array<{ embedding: import('node:sqlite').SQLOutputValue | null }>;
      return [
        ...new Set(
          rows
            .map((row) => decodeEmbedding(row.embedding).length)
            .filter((dimension) => dimension > 0),
        ),
      ].sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  /**
   * Remove KG rows for files that no longer exist on disk within the scanned
   * root. Project-scoped; chunked to respect SQLite's parameter limit.
   * Best-effort: a prune failure must never abort the scan.
   */
  private pruneDeletedFiles(files: string[], root: string): void {
    try {
      const scanned = new Set(files.map((f) => relative(root, f).replace(/\\/g, '/')));
      const rows = this.db
        .prepare('SELECT relative_path FROM files WHERE project_id = ?')
        .all(this.kg.getCurrentProjectId()) as Array<{ relative_path: string }>;
      const missing = rows.map((r) => r.relative_path).filter((p) => !scanned.has(p));
      const chunkSize = 999;
      for (let i = 0; i < missing.length; i += chunkSize) {
        const chunk = missing.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        this.db
          .prepare(`DELETE FROM files WHERE project_id = ? AND relative_path IN (${placeholders})`)
          .run(this.kg.getCurrentProjectId(), ...chunk);
      }
    } catch (error) {
      reportSuppressedError(error, 'Intentional fallback src/core/scale/reporting/scanner.ts:266');
      // best-effort prune — never abort the scan
    }
  }

  /**
   * Filter files to only include those whose content hash differs from the
   * indexed source. mtime is deliberately not used as the authority: editors,
   * checkout operations, and restored files can preserve or rewind timestamps
   * while changing bytes. Reading each bounded source once makes incremental
   * scans content-addressed and keeps the graph honest.
   */
  private async filterChangedFiles(files: string[], root: string): Promise<string[]> {
    if (files.length === 0) return [];

    const changed: string[] = [];
    const relPaths: string[] = [];

    for (const filePath of files) {
      try {
        const relPath = relative(root, filePath).replace(/\\/g, '/');
        relPaths.push(relPath);
      } catch {
        changed.push(filePath);
      }
    }

    // Batch query: fetch all indexed hashes in a single query.
    const metadataMap = this.batchGetFileMetadata(relPaths);

    for (const filePath of files) {
      try {
        const fileStat = await stat(filePath);
        if (fileStat.size > MAX_SCAN_FILE_BYTES) continue;
        const relPath = relative(root, filePath).replace(/\\/g, '/');

        const metadata = metadataMap.get(relPath);
        if (!metadata || metadata.sizeBytes !== fileStat.size) {
          changed.push(filePath);
          continue;
        }
        const content = (await readFile(filePath, 'utf-8')).replace(/^\uFEFF/, '');
        const currentHash = stableHash(content);
        if (metadata.hash !== currentHash) {
          changed.push(filePath);
        }
      } catch {
        changed.push(filePath);
      }
    }

    return changed;
  }

  /** Batch fetch indexed content hashes for multiple files in one query. */
  private batchGetFileMetadata(
    relPaths: string[],
  ): Map<string, { hash: string; sizeBytes: number | null }> {
    const result = new Map<string, { hash: string; sizeBytes: number | null }>();
    if (relPaths.length === 0) return result;

    try {
      // Split into chunks of 999 to avoid SQLite parameter limit
      const chunkSize = 999;
      for (let i = 0; i < relPaths.length; i += chunkSize) {
        const chunk = relPaths.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = this.db
          .prepare(
            `SELECT relative_path, hash, size_bytes FROM files WHERE relative_path IN (${placeholders}) AND project_id = ?`,
          )
          .all(...chunk, this.kg.getCurrentProjectId()) as Array<{
          relative_path: string;
          hash: string | null;
          size_bytes: number | null;
        }>;

        for (const row of rows) {
          if (row.hash)
            result.set(row.relative_path, { hash: row.hash, sizeBytes: row.size_bytes });
        }
      }
    } catch (error) {
      reportSuppressedError(error, 'Intentional fallback src/core/scale/reporting/scanner.ts:348');
      // If batch query fails, return empty map (all files will be scanned).
    }

    return result;
  }
}
