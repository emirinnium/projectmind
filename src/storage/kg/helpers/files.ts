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
import { runWithRetry } from '../../database.js';

import type { FileInfo } from '../types.js';

import type { KgContext } from './context.js';

import { getAllFiles, getFileByPath } from './file-queries.js';

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

  const jsExtensions = ['.js', '.jsx', '.mjs', '.cjs'];
  const tsExtensions = ['.ts', '.tsx', '.mts', '.cts'];
  for (let i = 0; i < jsExtensions.length; i++) {
    if (searchPath.endsWith(jsExtensions[i])) {
      searchPath = searchPath.slice(0, -jsExtensions[i].length) + tsExtensions[i];
      break;
    }
  }

  let file = getFileByPath(ctx, searchPath);
  if (file) return file;

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
  for (const ext of indexExtensions) {
    file = getFileByPath(ctx, searchPath + ext);
    if (file) return file;
  }

  const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
  for (const ext of extensions) {
    if (!searchPath.includes('.') || searchPath.endsWith('/')) {
      file = getFileByPath(ctx, searchPath + ext);
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
    if (f.relativePath === searchPath || f.relativePath === searchPath + '/index') {
      return f;
    }
  }

  return null;
}

export async function upsertFile(
  ctx: KgContext,
  fileStruct: FileStructure,
  relativePath: string,
): Promise<number> {
  // Embed the actual source whenever it is available. Signature-only vectors
  // make unrelated files with no top-level functions identical and caused
  // false redundancy findings. The structural fallback keeps programmatic
  // callers that construct FileStructure objects working.
  const embeddingInput =
    fileStruct.sourceText ??
    [
      fileStruct.filePath,
      ...fileStruct.imports.map((item) => `import ${item.source}`),
      ...fileStruct.classes.map((item) => item.signature),
      ...fileStruct.functions.map((item) => item.signature),
      ...fileStruct.exports.map((item) => `export ${item}`),
    ].join('\n');
  const embedding = await generateConfiguredEmbedding(embeddingInput);
  // Compact Float32 BLOB (~4 bytes/dim) instead of JSON text (~7+/bytes/dim).
  // Readers accept BOTH formats, so pre-existing TEXT rows convert gradually
  // on rescan without a destructive migration.
  const embeddingBlob = encodeEmbedding(embedding);
  const cognitiveLoad = calculateCognitiveLoad(fileStruct);

  return runWithRetry(async () => {
    const existing = ctx.db
      .prepare('SELECT id FROM files WHERE path = ? AND project_id = ?')
      .get(fileStruct.filePath, ctx.currentProjectId) as { id: number } | undefined;

    if (existing) {
      ctx.db
        .prepare(
          `UPDATE files SET relative_path = ?, language = ?, size_bytes = ?, hash = ?, embedding = ?, 
         last_scanned = CURRENT_TIMESTAMP, cognitive_load = ? WHERE id = ?`,
        )
        .run(
          relativePath,
          fileStruct.language,
          fileStruct.sizeBytes,
          fileStruct.hash,
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
          fileStruct.filePath,
          relativePath,
          fileStruct.language,
          fileStruct.sizeBytes,
          fileStruct.hash,
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
