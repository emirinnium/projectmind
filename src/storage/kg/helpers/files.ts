import { dirname, isAbsolute, join, resolve } from 'node:path';

import { globalCacheRegistry } from '../../../core/cache/index.js';

import { getDefaultImportResolutionCache } from '../../../core/cache/import-resolution-cache.js';

import { encodeEmbedding } from '../../../core/embeddings/embedding-codec.js';

import { getVecIndex } from '../../../core/embeddings/vector-index.js';

import { FileStructure } from '../../../parser/ast-parser.js';

import { getDefaultAliasResolver } from '../../../parser/alias-resolver.js';

import {
  codeToEmbedding,
  generateEmbedding,
  generateEmbeddingBatch,
  getCurrentProvider,
} from '../../../parser/embeddings.js';

import { loadConfig } from '../../../utils/config.js';
import { canonicalPath, pathsEqual } from '../../../utils/paths.js';
import { runWithRetry } from '../../database.js';

import type { FileInfo } from '../types.js';

import type { KgContext } from './context.js';

import { getAllFiles, getFileByPath } from './file-queries.js';
import { rebuildSourceRangeIndex } from '../../../core/retrieval/source-index.js';

export {
  getAllFiles,
  getFileByPath,
  getAgentTouchedFiles,
  getFileById,
  getFilesByLanguage,
  mapFileInfo,
} from './file-queries.js';
export { getClasses, getFileEmbedding, getFunctions, getImports } from './file-details.js';
export { findSimilarFiles } from './file-similarity.js';

function clearFileRelations(ctx: KgContext, fileId: number): void {
  ctx.db.prepare('DELETE FROM functions WHERE file_id = ?').run(fileId);
  ctx.db.prepare('DELETE FROM classes WHERE file_id = ?').run(fileId);
  ctx.db.prepare('DELETE FROM imports WHERE file_id = ?').run(fileId);
}

function resolveStaticCallTarget(
  ctx: KgContext,
  fileId: number,
  fileStruct: FileStructure,
  fromDir: string,
  targetName: string,
): number | null {
  const local = ctx.db
    .prepare('SELECT id FROM functions WHERE file_id = ? AND name = ? LIMIT 1')
    .get(fileId, targetName) as { id: number } | undefined;
  if (local) return local.id;

  const imported = fileStruct.imports.find((item) => item.named.includes(targetName));
  if (imported) {
    const targetFile = resolveImportSource(ctx, imported.source, fromDir);
    if (targetFile) {
      const target = ctx.db
        .prepare('SELECT id FROM functions WHERE file_id = ? AND name = ? LIMIT 1')
        .get(targetFile.id, targetName) as { id: number } | undefined;
      if (target) return target.id;
    }
  }

  // A unique project-local function is a useful fallback when import syntax
  // is indirect (for example a CommonJS export). Ambiguous names remain
  // unresolved instead of producing a false call edge.
  const candidates = ctx.db
    .prepare(
      `SELECT fn.id FROM functions fn JOIN files f ON f.id = fn.file_id
       WHERE f.project_id = ? AND fn.name = ? LIMIT 2`,
    )
    .all(ctx.currentProjectId, targetName) as Array<{ id: number }>;
  return candidates.length === 1 ? candidates[0]!.id : null;
}

function calculateCognitiveLoad(fileStruct: FileStructure): number {
  const complexityScore = fileStruct.functions.reduce(
    (sum: number, fn: { cyclomaticComplexity: number }) => sum + fn.cyclomaticComplexity,
    0,
  );
  const importCount = fileStruct.imports.length;
  const functionCount = fileStruct.functions.length;
  return (complexityScore * 0.5 + importCount * 0.3 + functionCount * 0.2) / 100;
}

/**
 * Generate an index vector using the active provider and configured
 * dimension. The synchronous legacy path is retained for the default simple
 * provider, while explicit optional providers are used consistently for both
 * file and symbol rows.
 */
async function generateConfiguredEmbedding(text: string): Promise<number[]> {
  const dimension = loadConfig().embeddings.dimension;
  return getCurrentProvider() === 'simple'
    ? codeToEmbedding(text, dimension)
    : generateEmbedding(text, dimension);
}

async function generateConfiguredEmbeddings(texts: readonly string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const dimension = loadConfig().embeddings.dimension;
  return getCurrentProvider() === 'simple'
    ? texts.map((text) => codeToEmbedding(text, dimension))
    : generateEmbeddingBatch(texts, dimension);
}

let _allFilesCache: { projectId: number; files: FileInfo[]; computedAt: number } | null = null;
const ALL_FILES_CACHE_TTL_MS = 5_000;

export function resolveImportSource(
  ctx: KgContext,
  source: string,
  fromDir?: string,
): FileInfo | null {
  let searchPath = source;
  if (fromDir && (source.startsWith('./') || source.startsWith('../'))) {
    const projectRoot = resolve(ctx.projectRoot ?? loadConfig().projectRoot);
    const baseDir = isAbsolute(fromDir) ? fromDir : join(projectRoot, fromDir);
    const absoluteSearchPath = resolve(baseDir, source);
    const normalizedRoot = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
    const normalizedSearchPath = absoluteSearchPath.replace(/\\/g, '/');
    const rootPrefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`;
    if (normalizedSearchPath === normalizedRoot || !normalizedSearchPath.startsWith(rootPrefix)) {
      return null;
    }
    searchPath = normalizedSearchPath.slice(rootPrefix.length);
  }

  const searchPaths = getImportPathCandidates(searchPath);

  for (const candidate of searchPaths) {
    const file = getFileByPath(ctx, candidate);
    if (file) return file;
  }

  const indexExtensions = [
    '/index.ts',
    '/index.tsx',
    '/index.mts',
    '/index.cts',
    '/index.js',
    '/index.jsx',
    '/index.mjs',
    '/index.cjs',
  ];
  for (const candidate of searchPaths) {
    for (const ext of indexExtensions) {
      const file = getFileByPath(ctx, candidate + ext);
      if (file) return file;
    }
  }

  const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
  for (const candidate of searchPaths) {
    for (const ext of extensions) {
      // A dot may belong to a directory name (`feature.v2/utils`), not an
      // extension. Exact candidates were checked above, so probing every
      // candidate here is both safe and required for dotted directories.
      const file = getFileByPath(ctx, candidate + ext);
      if (file) return file;
    }
  }

  if (
    !_allFilesCache ||
    _allFilesCache.projectId !== ctx.currentProjectId ||
    Date.now() - _allFilesCache.computedAt >= ALL_FILES_CACHE_TTL_MS
  ) {
    _allFilesCache = {
      projectId: ctx.currentProjectId,
      files: getAllFiles(ctx),
      computedAt: Date.now(),
    };
  }
  for (const f of _allFilesCache.files) {
    for (const candidate of searchPaths) {
      if (f.relativePath === candidate || f.relativePath === candidate + '/index') {
        return f;
      }
    }
  }

  return null;
}

/**
 * Keep both the exact runtime path and the TypeScript source equivalent.
 * Published ESM often imports `./file.js` while the source checkout contains
 * `file.ts`; JavaScript projects, however, legitimately contain `file.js`.
 * The exact path must win so the resolver never hides a real JS module.
 */
export function getImportPathCandidates(searchPath: string): string[] {
  const candidates = [searchPath];
  const extensionMap: Readonly<Record<string, string>> = {
    '.js': '.ts',
    '.jsx': '.tsx',
    '.mjs': '.mts',
    '.cjs': '.cts',
  };
  for (const [from, to] of Object.entries(extensionMap)) {
    if (searchPath.endsWith(from)) {
      candidates.push(searchPath.slice(0, -from.length) + to);
      break;
    }
  }
  return [...new Set(candidates)];
}

export async function upsertFile(
  ctx: KgContext,
  fileStruct: FileStructure,
  relativePath: string,
): Promise<number> {
  const normalizedFilePath = canonicalPath(fileStruct.filePath);
  const normalizedRelativePath = canonicalPath(relativePath);
  const normalizedFileStruct =
    normalizedFilePath === fileStruct.filePath
      ? fileStruct
      : { ...fileStruct, filePath: normalizedFilePath };

  // Embed the actual source whenever it is available. Signature-only vectors
  // make unrelated files with no top-level functions identical and caused
  // false redundancy findings. The structural fallback keeps programmatic
  // callers that construct FileStructure objects working.
  const embeddingInput =
    normalizedFileStruct.sourceText ??
    [
      normalizedFileStruct.filePath,
      ...normalizedFileStruct.imports.map((item) => `import ${item.source}`),
      ...normalizedFileStruct.classes.map((item) => item.signature),
      ...normalizedFileStruct.functions.map((item) => item.signature),
      ...normalizedFileStruct.exports.map((item) => `export ${item}`),
    ].join('\n');
  const embedding = await generateConfiguredEmbedding(embeddingInput);
  // Compact Float32 BLOB (~4 bytes/dim) instead of JSON text (~7+/bytes/dim).
  // Readers accept BOTH formats, so pre-existing TEXT rows convert gradually
  // on rescan without a destructive migration.
  const embeddingBlob = encodeEmbedding(embedding);
  const cognitiveLoad = calculateCognitiveLoad(normalizedFileStruct);

  return runWithRetry(async () => {
    const directCandidates = ctx.db
      .prepare(
        `SELECT id, path, relative_path FROM files
         WHERE project_id = ? AND (path = ? OR relative_path = ?)
         ORDER BY CASE WHEN path = ? THEN 0 WHEN relative_path = ? THEN 1 ELSE 2 END, id DESC`,
      )
      .all(
        ctx.currentProjectId,
        normalizedFilePath,
        normalizedRelativePath,
        normalizedFilePath,
        normalizedRelativePath,
      ) as Array<{ id: number; path: string; relative_path: string }>;
    const candidates =
      directCandidates.length > 0
        ? directCandidates
        : (
            ctx.db
              .prepare('SELECT id, path, relative_path FROM files WHERE project_id = ?')
              .all(ctx.currentProjectId) as Array<{
              id: number;
              path: string;
              relative_path: string;
            }>
          ).filter(
            (row) =>
              pathsEqual(row.path, normalizedFilePath) ||
              pathsEqual(row.relative_path, normalizedRelativePath),
          );
    const existing = candidates[0];

    // Older databases may contain the same file under both separator
    // conventions. Keep one graph identity and remove only the redundant
    // rows; foreign keys cascade their stale symbols/ranges/imports.
    for (const duplicate of candidates.slice(1)) {
      getVecIndex(ctx.db).remove(duplicate.id);
      ctx.db
        .prepare('DELETE FROM files WHERE id = ? AND project_id = ?')
        .run(duplicate.id, ctx.currentProjectId);
    }

    if (existing) {
      ctx.db
        .prepare(
          `UPDATE files SET relative_path = ?, language = ?, size_bytes = ?, hash = ?, embedding = ?, 
         last_scanned = CURRENT_TIMESTAMP, cognitive_load = ? WHERE id = ?`,
        )
        .run(
          normalizedRelativePath,
          normalizedFileStruct.language,
          normalizedFileStruct.sizeBytes,
          normalizedFileStruct.hash,
          embeddingBlob,
          cognitiveLoad,
          existing.id,
        );
      // The embedding changed — evict the stale cached copy so similarity
      // search reflects the new content instead of the pre-update vector.
      globalCacheRegistry.get('embeddings')?.delete(`file:${existing.id}`);
      clearFileRelations(ctx, existing.id);
      // Keep the sqlite-vec index in sync.
      getVecIndex(ctx.db, embedding.length).upsert(existing.id, embedding);
      return existing.id;
    } else {
      const result = ctx.db
        .prepare(
          `INSERT INTO files (project_id, path, relative_path, language, size_bytes, hash, embedding, cognitive_load)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ctx.currentProjectId,
          normalizedFileStruct.filePath,
          normalizedRelativePath,
          normalizedFileStruct.language,
          normalizedFileStruct.sizeBytes,
          normalizedFileStruct.hash,
          embeddingBlob,
          cognitiveLoad,
        );
      const newId = Number(result.lastInsertRowid);
      // Keep the sqlite-vec index in sync.
      getVecIndex(ctx.db, embedding.length).upsert(newId, embedding);
      return newId;
    }
  });
}

export async function storeFileDetails(
  ctx: KgContext,
  fileId: number,
  fileStruct: FileStructure,
): Promise<void> {
  const symbolTexts = [
    ...fileStruct.functions.map((fn) => fn.signature),
    ...fileStruct.classes.map((cls) => cls.signature),
  ];
  const symbolEmbeddings = await generateConfiguredEmbeddings(symbolTexts);

  return runWithRetry(
    async () => {
      ctx.db.exec('SAVEPOINT storeFileDetails');
      try {
        const fnStmt = ctx.db.prepare(
          `INSERT INTO functions (file_id, name, signature, return_type, start_line, end_line, complexity, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const [index, fn] of fileStruct.functions.entries()) {
          fnStmt.run(
            fileId,
            fn.name,
            fn.signature,
            fn.returnType,
            fn.startLine,
            fn.endLine,
            fn.cyclomaticComplexity,
            encodeEmbedding(symbolEmbeddings[index]!),
          );
        }

        const clsStmt = ctx.db.prepare(
          `INSERT INTO classes (file_id, name, signature, start_line, end_line, methods_count, properties_count, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const [index, cls] of fileStruct.classes.entries()) {
          clsStmt.run(
            fileId,
            cls.name,
            cls.signature,
            cls.startLine,
            cls.endLine,
            cls.methodsCount,
            cls.propertiesCount,
            encodeEmbedding(symbolEmbeddings[fileStruct.functions.length + index]!),
          );
        }

        const impStmt = ctx.db.prepare(
          `INSERT INTO imports (file_id, source, named, kind, resolved, resolved_path) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const fromFile = getFileByPath(ctx, fileStruct.filePath);
        const fromDir = fromFile ? dirname(fromFile.relativePath).replace(/\\/g, '/') : '';

        // Use the AliasResolver for tsconfig path alias resolution
        const aliasResolver = getDefaultAliasResolver();
        aliasResolver.loadAliases();

        // Use the import resolution cache for faster lookups
        const importCache = getDefaultImportResolutionCache();

        for (const imp of fileStruct.imports) {
          let resolved = false;
          let resolvedPath: string | null = null;

          // Auto-resolve Node.js built-in modules (e.g. 'node:fs', 'node:path').
          if (imp.source.startsWith('node:')) {
            resolved = true;
            resolvedPath = imp.source.slice('node:'.length);
          }

          // Try alias resolution first for bare imports
          if (!resolved && aliasResolver.isResolvable(imp.source)) {
            const aliasPath = aliasResolver.resolveAliasToPath(imp.source);
            if (aliasPath) {
              const found = resolveImportSource(ctx, aliasPath);
              if (found) {
                resolved = true;
                resolvedPath = found.relativePath;
              }
            }
          }

          // Use import resolution cache for relative imports and fallback
          if (!resolved) {
            const cacheResult = importCache.resolve(
              imp.source,
              fromDir,
              ctx.db,
              ctx.currentProjectId,
            );
            if (cacheResult.resolved && cacheResult.resolvedPath) {
              resolved = true;
              resolvedPath = cacheResult.resolvedPath;
            }
          }

          // Final fallback to direct resolution
          if (!resolved) {
            const found = resolveImportSource(ctx, imp.source, fromDir);
            if (found) {
              resolved = true;
              resolvedPath = found.relativePath;
            }
          }

          impStmt.run(
            fileId,
            imp.source,
            JSON.stringify(imp.named),
            imp.kind,
            resolved ? 1 : 0,
            resolvedPath,
          );
        }

        // F11: persist only AST-observed calls with a uniquely resolvable
        // target. Runtime/dynamic calls continue to use the trace pathway.
        ctx.db
          .prepare(
            `DELETE FROM calls WHERE dynamic = 0 AND from_function_id IN
             (SELECT id FROM functions WHERE file_id = ?)`,
          )
          .run(fileId);
        if (fileStruct.staticCalls && fileStruct.staticCalls.length > 0) {
          const functionIds = new Map<string, number>();
          const functionRows = ctx.db
            .prepare('SELECT id, name FROM functions WHERE file_id = ?')
            .all(fileId) as Array<{ id: number; name: string }>;
          for (const row of functionRows) {
            if (!functionIds.has(row.name)) functionIds.set(row.name, row.id);
          }
          const staticCallStmt = ctx.db.prepare(
            `INSERT INTO calls
             (from_function_id, to_function_id, dynamic, static_missed, call_count, workload_id)
             VALUES (?, ?, 0, 0, 1, NULL)`,
          );
          for (const call of fileStruct.staticCalls) {
            const fromId = functionIds.get(call.fromFunctionName);
            if (!fromId) continue;
            const toId = resolveStaticCallTarget(
              ctx,
              fileId,
              fileStruct,
              fromDir,
              call.toFunctionName,
            );
            if (toId) staticCallStmt.run(fromId, toId);
          }
        }

        // Persist coordinates from the same source snapshot that produced
        // the graph rows. The index is hash-addressed and clears stale rows
        // before inserting the current AST ranges.
        rebuildSourceRangeIndex(
          ctx.db,
          fileId,
          ctx.currentProjectId,
          fileStruct.filePath,
          fileStruct.sourceText,
        );

        ctx.db.exec('RELEASE SAVEPOINT storeFileDetails');
      } catch (e) {
        ctx.db.exec('ROLLBACK TO SAVEPOINT storeFileDetails');
        throw e;
      }
    },
    {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 1000,
      retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'database is locked'],
    },
  );
}

export function markAgentTouched(
  ctx: KgContext,
  filePath: string,
  agentName: string,
): Promise<void> {
  return runWithRetry(async () => {
    const normalized = filePath.replace(/\\/g, '/');
    ctx.db
      .prepare(
        `UPDATE files SET agent_touched = 1, agent_touched_by = ?, agent_touched_at = CURRENT_TIMESTAMP 
       WHERE path = ? OR relative_path = ?`,
      )
      .run(agentName, normalized, normalized);
  });
}
