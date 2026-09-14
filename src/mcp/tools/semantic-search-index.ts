import { reportSuppressedError } from '../../utils/errors.js';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { resolve } from 'node:path';
import { decodeEmbedding } from '../../core/embeddings/embedding-codec.js';
import {
  embeddingIndexConfigKey,
  parseEmbeddingIndexConfiguration,
  type EmbeddingIndexConfiguration,
} from '../../core/embeddings/index-configuration.js';

export type SemanticSearchScope = 'file' | 'symbol';
export type SemanticSearchSource =
  'files.embedding' | 'functions.embedding' | 'classes.embedding' | 'mixed';

export interface IndexedSearchMetadata {
  filePath: string;
  hash: string | null;
  lastScanned: string | null;
  kind: 'file' | 'function' | 'class';
  symbolName?: string;
  startLine?: number | null;
  endLine?: number | null;
}

export interface LoadedEmbeddingIndex {
  projectId: number | null;
  scope: SemanticSearchScope;
  candidateFiles: number;
  indexedFiles: number;
  candidateItems: number;
  indexedItems: number;
  invalidEmbeddings: number;
  dimensions: number[];
  embeddings: Map<string, number[]>;
  metadata: Map<string, IndexedSearchMetadata>;
  source: SemanticSearchSource;
  configuration: EmbeddingIndexConfiguration | null;
}

interface EmbeddingIndexCacheEntry {
  revision: string;
  index: LoadedEmbeddingIndex;
}

/**
 * Keep decoded vectors out of the hot request path. The revision is derived
 * from SQLite row counts, rowids, source timestamps, blob sizes and the
 * provider manifest, so normal scans invalidate the cache without allowing a
 * stale index to masquerade as current. The cache is per DB connection and
 * bounded by project/scope entries.
 */
const INDEX_CACHE_LIMIT = 8;
const indexCaches = new WeakMap<DatabaseSync, Map<string, EmbeddingIndexCacheEntry>>();

interface LoadedEmbeddingRow {
  itemId: string;
  kind: 'file' | 'function' | 'class';
  path: string;
  relative_path: string | null;
  embedding: SQLOutputValue | null;
  hash: string | null;
  last_scanned: string | null;
  symbolName?: string;
  startLine?: number | null;
  endLine?: number | null;
}

function resolveProjectId(db: DatabaseSync, projectRoot: string): number | null {
  const normalizedRoot = resolve(projectRoot);
  const byRoot = db
    .prepare('SELECT id FROM projects WHERE root_path = ? COLLATE NOCASE ORDER BY id LIMIT 1')
    .get(normalizedRoot) as { id: number } | undefined;
  if (byRoot) return byRoot.id;

  try {
    const setting = db
      .prepare("SELECT value FROM settings WHERE key = 'current_project_id'")
      .get() as { value: string } | undefined;
    if (setting) {
      const parsed = Number.parseInt(setting.value, 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        const exists = db.prepare('SELECT id FROM projects WHERE id = ?').get(parsed) as
          { id: number } | undefined;
        if (exists) return parsed;
      }
    }
  } catch (error) {
    reportSuppressedError(error, 'Intentional fallback src/mcp/tools/semantic-search-index.ts:71');
    // Older databases may not have settings yet; use the default project below.
  }

  const defaultProject = db.prepare('SELECT id FROM projects WHERE id = 1').get() as
    { id: number } | undefined;
  return defaultProject ? defaultProject.id : null;
}

function loadIndexConfiguration(
  db: DatabaseSync,
  projectId: number,
): EmbeddingIndexConfiguration | null {
  try {
    const row = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(embeddingIndexConfigKey(projectId)) as { value: string } | undefined;
    return parseEmbeddingIndexConfiguration(row?.value);
  } catch {
    // Legacy or partially initialized databases have no manifest. The caller
    // reports compatibility as unknown rather than trusting the index.
    return null;
  }
}

function getIndexRevision(db: DatabaseSync, projectId: number, scope: SemanticSearchScope): string {
  const fileStats = db
    .prepare(
      'SELECT COUNT(*) AS count, MAX(rowid) AS max_rowid, MAX(last_scanned) AS last_scanned, ' +
        'COALESCE(SUM(LENGTH(CAST(embedding AS TEXT))), 0) AS embedding_bytes ' +
        'FROM files WHERE project_id = ? AND embedding IS NOT NULL',
    )
    .get(projectId) as Record<string, string | number | bigint | null>;
  const symbolStats =
    scope === 'symbol'
      ? (db
          .prepare(
            'SELECT COUNT(*) AS count, MAX(fn.id) AS max_rowid, ' +
              'MAX(LENGTH(CAST(fn.embedding AS TEXT))) AS max_embedding_length, ' +
              'COALESCE(SUM(LENGTH(CAST(fn.embedding AS TEXT))), 0) AS embedding_bytes ' +
              'FROM functions fn JOIN files f ON f.id = fn.file_id ' +
              'WHERE f.project_id = ? AND fn.embedding IS NOT NULL',
          )
          .get(projectId) as Record<string, string | number | bigint | null>)
      : null;
  const classStats =
    scope === 'symbol'
      ? (db
          .prepare(
            'SELECT COUNT(*) AS count, MAX(cls.id) AS max_rowid, ' +
              'MAX(LENGTH(CAST(cls.embedding AS TEXT))) AS max_embedding_length, ' +
              'COALESCE(SUM(LENGTH(CAST(cls.embedding AS TEXT))), 0) AS embedding_bytes ' +
              'FROM classes cls JOIN files f ON f.id = cls.file_id ' +
              'WHERE f.project_id = ? AND cls.embedding IS NOT NULL',
          )
          .get(projectId) as Record<string, string | number | bigint | null>)
      : null;
  const manifest = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(embeddingIndexConfigKey(projectId)) as { value?: string } | undefined;
  return JSON.stringify(
    { scope, fileStats, symbolStats, classStats, manifest: manifest?.value ?? null },
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
  );
}

function loadRows(
  db: DatabaseSync,
  projectId: number,
  scope: SemanticSearchScope,
): LoadedEmbeddingRow[] {
  if (scope === 'file') {
    return (
      db
        .prepare(
          'SELECT path, relative_path, embedding, hash, last_scanned FROM files WHERE project_id = ? AND embedding IS NOT NULL',
        )
        .all(projectId) as Array<{
        path: string;
        relative_path: string | null;
        embedding: SQLOutputValue | null;
        hash: string | null;
        last_scanned: string | null;
      }>
    ).map((row) => ({
      ...row,
      itemId: row.relative_path || row.path,
      kind: 'file' as const,
    }));
  }

  return (
    db
      .prepare(
        'SELECT fn.id AS item_id, fn.name AS symbol_name, fn.start_line, fn.end_line, ' +
          'fn.embedding, f.path, f.relative_path, f.hash, f.last_scanned, ' +
          "'function' AS kind FROM functions fn JOIN files f ON f.id = fn.file_id " +
          'WHERE f.project_id = ? AND fn.embedding IS NOT NULL ' +
          'UNION ALL ' +
          'SELECT cls.id AS item_id, cls.name AS symbol_name, cls.start_line, cls.end_line, ' +
          'cls.embedding, f.path, f.relative_path, f.hash, f.last_scanned, ' +
          "'class' AS kind FROM classes cls JOIN files f ON f.id = cls.file_id " +
          'WHERE f.project_id = ? AND cls.embedding IS NOT NULL',
      )
      .all(projectId, projectId) as Array<{
      item_id: number;
      symbol_name: string;
      start_line: number | null;
      end_line: number | null;
      embedding: SQLOutputValue | null;
      path: string;
      relative_path: string | null;
      hash: string | null;
      last_scanned: string | null;
      kind: 'function' | 'class';
    }>
  ).map((row) => ({
    itemId: row.kind + ':' + String(row.item_id),
    kind: row.kind,
    path: row.path,
    relative_path: row.relative_path,
    embedding: row.embedding,
    hash: row.hash,
    last_scanned: row.last_scanned,
    symbolName: row.symbol_name,
    startLine: row.start_line,
    endLine: row.end_line,
  }));
}

export function loadEmbeddingIndex(
  db: DatabaseSync,
  projectRoot: string,
  scope: SemanticSearchScope,
): LoadedEmbeddingIndex {
  const projectId = resolveProjectId(db, projectRoot);
  if (projectId === null) {
    return {
      projectId: null,
      scope,
      candidateFiles: 0,
      indexedFiles: 0,
      candidateItems: 0,
      indexedItems: 0,
      invalidEmbeddings: 0,
      dimensions: [],
      embeddings: new Map(),
      metadata: new Map(),
      source: scope === 'file' ? 'files.embedding' : 'mixed',
      configuration: null,
    };
  }

  const cacheKey = `${projectId}:${scope}`;
  const revision = getIndexRevision(db, projectId, scope);
  const cache = indexCaches.get(db);
  const cached = cache?.get(cacheKey);
  if (cached?.revision === revision) {
    // LRU touch: recently-used project/scope combinations survive longer.
    cache!.delete(cacheKey);
    cache!.set(cacheKey, cached);
    return cached.index;
  }

  const rows = loadRows(db, projectId, scope);
  const map = new Map<string, number[]>();
  const metadata = new Map<string, IndexedSearchMetadata>();
  let invalidEmbeddings = 0;
  const sourceKinds = new Set<'function' | 'class'>();

  for (const row of rows) {
    const decoded = decodeEmbedding(row.embedding);
    if (decoded.length === 0 || decoded.some((value) => !Number.isFinite(value))) {
      invalidEmbeddings += 1;
      continue;
    }
    const filePath = (row.relative_path || row.path).replace(/\\/g, '/');
    const key = scope === 'file' ? filePath : row.itemId;
    map.set(key, decoded);
    metadata.set(key, {
      filePath,
      hash: row.hash ?? null,
      lastScanned: row.last_scanned ?? null,
      kind: row.kind,
      ...(row.symbolName !== undefined ? { symbolName: row.symbolName } : {}),
      ...(row.startLine !== undefined ? { startLine: row.startLine, endLine: row.endLine } : {}),
    });
    if (row.kind === 'function' || row.kind === 'class') sourceKinds.add(row.kind);
  }

  const source: SemanticSearchSource =
    scope === 'file'
      ? 'files.embedding'
      : sourceKinds.size === 2
        ? 'mixed'
        : sourceKinds.size === 0
          ? 'mixed'
          : sourceKinds.has('function')
            ? 'functions.embedding'
            : 'classes.embedding';
  const candidateFiles = new Set(
    rows.map((row) => (row.relative_path || row.path).replace(/\\/g, '/')),
  );
  const indexedFiles = new Set([...metadata.values()].map((item) => item.filePath));

  const index: LoadedEmbeddingIndex = {
    projectId,
    scope,
    candidateFiles: candidateFiles.size,
    indexedFiles: indexedFiles.size,
    candidateItems: rows.length,
    indexedItems: map.size,
    invalidEmbeddings,
    dimensions: [...new Set([...map.values()].map((embedding) => embedding.length))].sort(
      (a, b) => a - b,
    ),
    embeddings: map,
    metadata,
    source,
    configuration: loadIndexConfiguration(db, projectId),
  };
  const nextCache = cache ?? new Map<string, EmbeddingIndexCacheEntry>();
  nextCache.delete(cacheKey);
  nextCache.set(cacheKey, { revision, index });
  while (nextCache.size > INDEX_CACHE_LIMIT) {
    const oldest = nextCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    nextCache.delete(oldest);
  }
  if (!cache) indexCaches.set(db, nextCache);
  return index;
}
