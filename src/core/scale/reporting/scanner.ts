import { reportSuppressedError } from '../../../utils/errors.js';
import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../../../storage/database.js';
import { SCHEMA_SQL } from '../../../storage/schema.js';
import { KnowledgeGraph } from '../../../storage/knowledge-graph.js';
import { getVecIndex } from '../../../core/embeddings/vector-index.js';
import { parseFile } from '../../../parser/ast-parser.js';
import type { FileStructure } from '../../../parser/ast-parser.js';
import { PatternLibrary } from '../../../parser/pattern-extractor.js';
import { decodeEmbedding } from '../../../core/embeddings/embedding-codec.js';
import fg from 'fast-glob';
import { loadConfig } from '../../../utils/config.js';
import { getProjectIgnorePatterns } from '../../../utils/ignore.js';
import { stableHash } from '../../../utils/hash.js';
import { canonicalPath } from '../../../utils/paths.js';
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
import { expandIncrementalDependencyFiles } from './incremental.js';

/** Files larger than this are skipped (not counted as errors). */
export const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;
/** Bounded concurrent source preparation; SQLite writes remain serialized. */
const SCAN_PREPARATION_CONCURRENCY = 16;

type PreparedScanFile =
  | { status: 'ready'; filePath: string; relativePath: string; fileStruct: FileStructure }
  | { status: 'skipped'; relativePath: string }
  | { status: 'error'; filePath: string; message: string };

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker()),
  );
  return results;
}
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
    // The same scanner/graph instance may be reused for multiple repositories
    // (MCP scopes and integrations). Resolve the root
    // before any file or import operation so rows and path resolution belong
    // to the requested namespace rather than the constructor's cwd.
    this.kg.selectProjectRoot(root);
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

    const repairedPathRows = this.repairPersistedPathRows();
    const prunedFiles = this.pruneDeletedFiles(files, root);

    // Incremental scanning: only process files that have changed since last scan
    const changedFiles =
      full || embeddingIndexState.rebuildRequired
        ? files
        : await this.filterChangedFiles(files, root);
    const propagation =
      full || embeddingIndexState.rebuildRequired
        ? { files: changedFiles, dependencyFiles: [], depth: 0 }
        : expandIncrementalDependencyFiles(changedFiles, root, this.kg, 1);
    const filesToProcess = propagation.files;

    let scanned = 0;
    let errors = 0;
    let skippedFiles = 0;
    const skippedPaths: string[] = [];
    const errorDetails: string[] = [];
    const patternLib = new PatternLibrary(this.db, this.kg.getCurrentProjectId());

    // Process files in bounded batches. File stat/read/parse work is safe to
    // overlap, but graph/database writes must stay serialized because the
    // SQLite connection and PatternLibrary are synchronous and transactional.
    const batchSize = 50;
    for (let i = 0; i < filesToProcess.length; i += batchSize) {
      if (signal?.aborted) throw new Error('Project scan aborted');
      const batch = filesToProcess.slice(i, i + batchSize);

      const prepared = await mapWithConcurrency(batch, SCAN_PREPARATION_CONCURRENCY, (filePath) =>
        this.prepareScanFile(filePath, root, signal),
      );

      this.db.exec('BEGIN');
      try {
        for (const item of prepared) {
          if (signal?.aborted) throw new Error('Project scan aborted');
          if (item.status === 'skipped') {
            skippedFiles++;
            skippedPaths.push(item.relativePath);
            continue;
          }
          if (item.status === 'error') {
            errors++;
            errorDetails.push(`${item.filePath}: ${item.message}`);
            continue;
          }

          const fileId = await this.kg.upsertFile(item.fileStruct, item.relativePath);
          await this.kg.storeFileDetails(fileId, item.fileStruct);
          // Extract patterns for genome scoring
          patternLib.extractPatterns(item.fileStruct);
          scanned++;
        }
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        if (signal?.aborted) throw e;
        errorDetails.push(
          `Batch transaction failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        // Continue processing remaining batches instead of failing completely
      }
    }

    // Resolve once more after the batch so an importer encountered before a
    // newly added target cannot remain a false unresolved edge. Avoid the
    // pass on a clean incremental scan to preserve its fast path.
    if (
      full ||
      embeddingIndexState.rebuildRequired ||
      filesToProcess.length > 0 ||
      prunedFiles > 0 ||
      repairedPathRows > 0
    ) {
      try {
        this.kg.refreshImportResolution();
      } catch (error) {
        errors++;
        errorDetails.push(
          `Import resolution refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
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
      skippedFiles,
      skippedPaths: skippedPaths.sort((a, b) => a.localeCompare(b)),
      durationMs,
      filesPerSecond: durationMs > 0 ? Math.round(scanned / (durationMs / 1000)) : 0,
      memoryUsedMB: Math.round(((endMemory - startMemory) / 1024 / 1024) * 100) / 100,
      errors: errorDetails,
      dependencyFiles: propagation.dependencyFiles.length,
      dependencyDepth: propagation.depth,
    };
  }

  private async prepareScanFile(
    filePath: string,
    root: string,
    signal?: AbortSignal,
  ): Promise<PreparedScanFile> {
    try {
      if (signal?.aborted) throw new Error('Project scan aborted');
      const relativePath = relative(root, filePath).replace(/\\/g, '/');
      if ((await stat(filePath)).size > MAX_SCAN_FILE_BYTES) {
        return { status: 'skipped', relativePath };
      }
      if (signal?.aborted) throw new Error('Project scan aborted');
      const content = (await readFile(filePath, 'utf-8')).replace(/^\uFEFF/, '');
      const fileStruct = parseFile(filePath, content);
      if (!fileStruct) {
        return { status: 'error', filePath, message: 'Parse returned null' };
      }
      return { status: 'ready', filePath, relativePath, fileStruct };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        status: 'error',
        filePath,
        message: error instanceof Error ? error.message : String(error),
      };
    }
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
   * Normalize legacy persisted paths and remove duplicate rows created by
   * Windows/POSIX separator changes. The relative path is the project-local
   * identity; the most canonical existing row is retained and all redundant
   * graph rows are cascaded. This runs before incremental hash filtering so a
   * clean scan also repairs old databases.
   */
  private repairPersistedPathRows(): number {
    const projectId = this.kg.getCurrentProjectId();
    type FileRow = {
      id: number;
      path: string;
      relative_path: string;
      last_scanned: string | null;
    };

    try {
      const rows = this.db
        .prepare(
          'SELECT id, path, relative_path, last_scanned FROM files WHERE project_id = ? ORDER BY id',
        )
        .all(projectId) as FileRow[];
      const groups = new Map<string, FileRow[]>();
      for (const row of rows) {
        const relativePath = canonicalPath(row.relative_path);
        const key = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
        const group = groups.get(key);
        if (group) group.push(row);
        else groups.set(key, [row]);
      }

      const repairs = [...groups.values()].filter((group) => {
        const row = group[0];
        return (
          group.length > 1 ||
          (row !== undefined &&
            (row.path !== canonicalPath(row.path) ||
              row.relative_path !== canonicalPath(row.relative_path)))
        );
      });
      if (repairs.length === 0) return 0;

      this.db.exec('BEGIN');
      let changedRows = 0;
      try {
        for (const group of repairs) {
          const sorted = [...group].sort((left, right) => {
            // Prefer the most recently scanned row so a separator repair does
            // not discard newer symbols/imports merely because an older row
            // already used the canonical slash convention.
            const leftScanned = left.last_scanned ?? '';
            const rightScanned = right.last_scanned ?? '';
            if (leftScanned !== rightScanned) return rightScanned.localeCompare(leftScanned);
            const leftCanonical = left.path === canonicalPath(left.path) ? 0 : 1;
            const rightCanonical = right.path === canonicalPath(right.path) ? 0 : 1;
            if (leftCanonical !== rightCanonical) return leftCanonical - rightCanonical;
            return right.id - left.id;
          });
          const retained = sorted[0];
          if (!retained) continue;
          for (const duplicate of sorted.slice(1)) {
            getVecIndex(this.db).remove(duplicate.id);
            this.db
              .prepare('DELETE FROM files WHERE id = ? AND project_id = ?')
              .run(duplicate.id, projectId);
            changedRows++;
          }

          const normalizedPath = canonicalPath(retained.path);
          const normalizedRelativePath = canonicalPath(retained.relative_path);
          if (
            retained.path !== normalizedPath ||
            retained.relative_path !== normalizedRelativePath
          ) {
            this.db
              .prepare(
                'UPDATE files SET path = ?, relative_path = ? WHERE id = ? AND project_id = ?',
              )
              .run(normalizedPath, normalizedRelativePath, retained.id, projectId);
            changedRows++;
          }
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      return changedRows;
    } catch (error) {
      reportSuppressedError(error, 'Intentional fallback src/core/scale/reporting/scanner.ts:365');
      // A legacy repair must never turn an otherwise safe scan into a failure.
      return 0;
    }
  }

  /**
   * Remove KG rows for files that no longer exist on disk within the scanned
   * root. Project-scoped; chunked to respect SQLite's parameter limit.
   * Best-effort: a prune failure must never abort the scan.
   */
  private pruneDeletedFiles(files: string[], root: string): number {
    let deletedFiles = 0;
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
        const result = this.db
          .prepare(`DELETE FROM files WHERE project_id = ? AND relative_path IN (${placeholders})`)
          .run(this.kg.getCurrentProjectId(), ...chunk);
        deletedFiles += Number(result.changes);
      }
    } catch (error) {
      reportSuppressedError(error, 'Intentional fallback src/core/scale/reporting/scanner.ts:266');
      // best-effort prune — never abort the scan
    }
    return deletedFiles;
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
