import type { SQLOutputValue } from 'node:sqlite';

import { decodeEmbedding } from '../../../core/embeddings/embedding-codec.js';

import type { KgContext } from './context.js';

export function getFunctions(
  ctx: KgContext,
  fileId: number,
): {
  id: number;
  name: string;
  signature: string;
  complexity: number;
  startLine: number;
  endLine: number;
}[] {
  const rows = ctx.db
    .prepare(
      'SELECT id, name, signature, complexity, start_line, end_line FROM functions WHERE file_id = ?',
    )
    .all(fileId) as Record<string, SQLOutputValue>[];
  return rows.map((row) => ({
    id: row.id as number,
    name: row.name as string,
    signature: row.signature as string,
    complexity: row.complexity as number,
    startLine: row.start_line as number,
    endLine: row.end_line as number,
  }));
}

export function getClasses(
  ctx: KgContext,
  fileId: number,
): { id: number; name: string; methodsCount: number; propertiesCount: number }[] {
  const rows = ctx.db
    .prepare('SELECT id, name, methods_count, properties_count FROM classes WHERE file_id = ?')
    .all(fileId) as Record<string, SQLOutputValue>[];
  return rows.map((row) => ({
    id: row.id as number,
    name: row.name as string,
    methodsCount: row.methods_count as number,
    propertiesCount: row.properties_count as number,
  }));
}

export function getImports(
  ctx: KgContext,
  fileId: number,
): { source: string; named: string[]; kind: string }[] {
  const rows = ctx.db.prepare('SELECT * FROM imports WHERE file_id = ?').all(fileId) as Record<
    string,
    SQLOutputValue
  >[];
  return rows.map((row) => ({
    source: row.source as string,
    named: parseNamedBindings(row.named),
    kind: row.kind as string,
  }));
}

function parseNamedBindings(raw: SQLOutputValue): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

export function getFileEmbedding(ctx: KgContext, fileId: number): number[] | null {
  const row = ctx.db.prepare('SELECT embedding FROM files WHERE id = ?').get(fileId) as
    { embedding: SQLOutputValue | null } | undefined;
  if (!row || !row.embedding) return null;
  const decoded = decodeEmbedding(row.embedding);
  return decoded.length > 0 ? decoded : null;
}
