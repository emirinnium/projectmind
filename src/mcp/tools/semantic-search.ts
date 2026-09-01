import { z } from 'zod';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { searchSemantic } from '@/core/search/semantic.js';
import { generateEmbedding, cosineSimilarity } from '@/parser/embeddings.js';

/**
 * semantic_search — pure natural-language semantic file search over the
 * project's stored file embeddings.
 *
 * Given a natural-language `query`, embeds it with the active embedding
 * provider and ranks every indexed file by cosine similarity to its stored
 * embedding, returning only files whose score meets `threshold` (default 0.7),
 * capped at `limit` (default 5).
 *
 * This is a thin, read-only wrapper around the core `searchSemantic` engine
 * (src/core/search/semantic.ts). It wires the engine to the live project DB:
 * file embeddings are read from the `files` table (Float32 BLOB or legacy JSON
 * TEXT) for the project whose root matches `deps.projectRoot`.
 */

/** Input accepted by the semantic_search tool. */
export interface SemanticSearchArgs {
  query: string;
  limit?: number;
  threshold?: number;
}

/** A single ranked hit. */
export interface SemanticSearchHit {
  filePath: string;
  score: number;
}

/** Result of a semantic search run. */
export interface SemanticSearchResult {
  results: SemanticSearchHit[];
}

/**
 * Decode an embedding stored in either the compact Float32 BLOB format or the
 * legacy JSON TEXT format (parity with storage/repositories/file-repository.ts
 * and storage/kg/helpers/files.ts). Returns an empty array when unreadable.
 */
function decodeEmbedding(raw: SQLOutputValue | null): number[] {
  if (raw instanceof Uint8Array) {
    const floats = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
    return Array.from(floats);
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as number[];
      return Array.isArray(parsed) ? parsed.map(Number) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Resolve the active project id for `projectRoot`. Prefers a project whose
 * `root_path` matches the root, then the persisted `current_project_id`
 * setting, then the default project (id 1). Returns `null` when no project
 * can be determined.
 */
function resolveProjectId(db: DatabaseSync, projectRoot: string): number | null {
  const byRoot = db
    .prepare('SELECT id FROM projects WHERE root_path = ? ORDER BY id LIMIT 1')
    .get(projectRoot) as { id: number } | undefined;
  if (byRoot) return byRoot.id;

  try {
    const setting = db
      .prepare("SELECT value FROM settings WHERE key = 'current_project_id'")
      .get() as { value: string } | undefined;
    if (setting) {
      const parsed = parseInt(setting.value, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        const exists = db.prepare('SELECT id FROM projects WHERE id = ?').get(parsed) as
          { id: number } | undefined;
        if (exists) return parsed;
      }
    }
  } catch {
    // settings table may not exist yet in older databases — fall through.
  }

  const defaultProject = db.prepare('SELECT id FROM projects WHERE id = 1').get() as
    { id: number } | undefined;
  return defaultProject ? defaultProject.id : null;
}

/**
 * Load every indexed file embedding for the active project as a
 * `Map<filePath, number[]>` keyed by the file's relative path (falling back to
 * its absolute path when no relative path is stored).
 */
function loadFileEmbeddings(db: DatabaseSync, projectRoot: string): Map<string, number[]> {
  const projectId = resolveProjectId(db, projectRoot);
  if (projectId === null) return new Map();

  const rows = db
    .prepare(
      'SELECT path, relative_path, embedding FROM files WHERE project_id = ? AND embedding IS NOT NULL',
    )
    .all(projectId) as Array<{
    path: string;
    relative_path: string | null;
    embedding: SQLOutputValue | null;
  }>;

  const map = new Map<string, number[]>();
  for (const row of rows) {
    const decoded = decodeEmbedding(row.embedding);
    if (decoded.length === 0) continue;
    const key = (row.relative_path || row.path).replace(/\\/g, '/');
    map.set(key, decoded);
  }
  return map;
}

/**
 * Run a semantic search over the project's stored file embeddings.
 *
 * Pure and dependency-light (only `deps.db` + `deps.projectRoot` are read), so
 * it is directly unit-testable — mirroring the `evaluateContracts` /
 * `predictMergeRiskForTool` pattern of exporting the core logic for tests.
 *
 * `embeddingGenerator` is injectable so tests can supply a deterministic
 * vector without touching the real (possibly network-backed) provider.
 */
export async function semanticSearchForTool(
  deps: McpDependencies,
  args: SemanticSearchArgs,
  embeddingGenerator: (text: string) => Promise<number[]> = generateEmbedding,
): Promise<SemanticSearchResult> {
  if (!deps.db) {
    throw new Error('semantic_search requires the project database, which is not initialized.');
  }
  const fileEmbeddings = loadFileEmbeddings(deps.db, deps.projectRoot);
  const results = await searchSemantic(
    args.query,
    embeddingGenerator,
    cosineSimilarity,
    fileEmbeddings,
    { limit: args.limit, threshold: args.threshold },
  );
  return { results };
}

export function registerSemanticSearchTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'semantic_search',
    {
      title: 'Semantic File Search',
      description:
        "Pure natural-language semantic file search over the project's stored embeddings.\n" +
        'WHEN to call: when you want files ranked purely by embedding similarity to a free-text query ' +
        '("rate limiting", "oauth token refresh") rather than a task intent or literal string.\n' +
        'Returns files whose cosine similarity to the query meets `threshold`, capped at `limit`.',
      inputSchema: {
        query: z.string().describe('Natural-language query to match against file embeddings'),
        limit: z.number().int().min(1).max(50).default(5).describe('Maximum number of results'),
        threshold: z
          .number()
          .min(0)
          .max(1)
          .default(0.7)
          .describe('Minimum cosine similarity (0..1) for a file to be returned'),
      },
    },
    async (args) => {
      try {
        const result = await semanticSearchForTool(deps, {
          query: args.query,
          limit: args.limit,
          threshold: args.threshold,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );
}
