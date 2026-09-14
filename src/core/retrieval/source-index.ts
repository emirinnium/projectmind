import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { assertProjectPath } from '../security/path-security.js';
import { readSourceRange, type SourceRangeResult } from './byte-range.js';

export type SourceRangeKind =
  'file' | 'function' | 'class' | 'method' | 'property' | 'import' | 'export';

export interface IndexedSourceRange {
  id: number;
  fileId: number;
  projectId: number;
  sourceHash: string;
  kind: SourceRangeKind;
  name: string;
  parentName: string | null;
  symbolPath: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

export interface SourceSymbolRangeResult extends SourceRangeResult {
  symbol: Pick<
    IndexedSourceRange,
    | 'kind'
    | 'name'
    | 'parentName'
    | 'symbolPath'
    | 'startByte'
    | 'endByte'
    | 'startLine'
    | 'endLine'
    | 'startColumn'
    | 'endColumn'
  >;
}

interface Position {
  byte: number;
  line: number;
  column: number;
}

interface PositionMapper {
  at(characterOffset: number): Position;
}

const SOURCE_RANGE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS source_ranges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL DEFAULT 1,
  source_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('file', 'function', 'class', 'method', 'property', 'import', 'export')),
  name TEXT NOT NULL,
  parent_name TEXT,
  symbol_path TEXT NOT NULL,
  start_byte INTEGER NOT NULL CHECK(start_byte >= 0),
  end_byte INTEGER NOT NULL CHECK(end_byte >= start_byte),
  start_line INTEGER NOT NULL CHECK(start_line >= 1),
  end_line INTEGER NOT NULL CHECK(end_line >= start_line),
  start_column INTEGER NOT NULL CHECK(start_column >= 1),
  end_column INTEGER NOT NULL CHECK(end_column >= 1),
  UNIQUE(file_id, source_hash, kind, name, start_byte, end_byte),
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_source_ranges_file_hash
  ON source_ranges(file_id, source_hash);
CREATE INDEX IF NOT EXISTS idx_source_ranges_project_symbol
  ON source_ranges(project_id, symbol_path, kind);
`;

/**
 * Rebuild the persisted coordinate index for one parsed file.
 *
 * The index stores UTF-8 byte offsets and TypeScript line/column coordinates
 * together. It is replaced as one unit whenever a file is re-indexed; old
 * rows can never be mistaken for current source.
 */
export function rebuildSourceRangeIndex(
  db: DatabaseSync,
  fileId: number,
  projectId: number,
  filePath: string,
  sourceText?: string,
): number {
  ensureSourceRangeTable(db);
  db.prepare('DELETE FROM source_ranges WHERE file_id = ? AND project_id = ?').run(
    fileId,
    projectId,
  );
  if (sourceText === undefined) return 0;

  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );
  const mapper = createPositionMapper(sourceText);
  const ranges: Array<{
    kind: SourceRangeKind;
    name: string;
    parentName: string | null;
    symbolPath: string;
    start: Position;
    end: Position;
  }> = [];

  const add = (
    node: ts.Node,
    kind: SourceRangeKind,
    name: string,
    parentName: string | null,
  ): void => {
    const start = mapper.at(node.getStart(sourceFile));
    const end = mapper.at(node.getEnd());
    if (end.byte < start.byte) return;
    ranges.push({
      kind,
      name,
      parentName,
      symbolPath: parentName ? `${parentName}.${name}` : name,
      start,
      end,
    });
  };

  ranges.push({
    kind: 'file',
    name: '<file>',
    parentName: null,
    symbolPath: '<file>',
    start: mapper.at(0),
    end: mapper.at(sourceText.length),
  });

  const visit = (node: ts.Node): void => {
    const classParent = findClassParent(node, sourceFile);
    if (ts.isClassDeclaration(node)) {
      add(
        node,
        'class',
        namedNodeText(node) ?? `anonymous-class@${lineOf(node, sourceFile)}`,
        null,
      );
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      const name = namedNodeText(node) ?? inferredFunctionName(node, sourceFile);
      add(node, ts.isMethodDeclaration(node) ? 'method' : 'function', name, classParent);
    } else if (ts.isPropertyDeclaration(node)) {
      const name = namedNodeText(node);
      if (name) add(node, 'property', name, classParent);
    } else if (ts.isImportDeclaration(node)) {
      add(node, 'import', `import@${lineOf(node, sourceFile)}`, null);
    } else if (ts.isExportDeclaration(node)) {
      add(node, 'export', `export@${lineOf(node, sourceFile)}`, null);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const insert = db.prepare(
    `INSERT INTO source_ranges
      (file_id, project_id, source_hash, kind, name, parent_name, symbol_path,
       start_byte, end_byte, start_line, end_line, start_column, end_column)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const sourceHash = sha256(sourceText);
  for (const range of ranges) {
    insert.run(
      fileId,
      projectId,
      sourceHash,
      range.kind,
      range.name,
      range.parentName,
      range.symbolPath,
      range.start.byte,
      range.end.byte,
      range.start.line,
      range.end.line,
      range.start.column,
      range.end.column,
    );
  }
  return ranges.length;
}

/** Return persisted ranges for a file, optionally constrained by kind/name. */
export function listIndexedSourceRanges(
  db: DatabaseSync,
  fileId: number,
  options: { sourceHash?: string; kind?: SourceRangeKind; symbol?: string; limit?: number } = {},
): IndexedSourceRange[] {
  ensureSourceRangeTable(db);
  const limit = options.limit ?? 5000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50_000) {
    throw new Error('Source range index limit must be an integer between 1 and 50000.');
  }
  const conditions = ['file_id = ?'];
  const params: Array<string | number> = [fileId];
  if (options.sourceHash) {
    conditions.push('source_hash = ?');
    params.push(options.sourceHash);
  }
  if (options.kind) {
    conditions.push('kind = ?');
    params.push(options.kind);
  }
  if (options.symbol) {
    conditions.push('(name = ? OR symbol_path = ?)');
    params.push(options.symbol, options.symbol);
  }
  const rows = db
    .prepare(
      `SELECT id, file_id, project_id, source_hash, kind, name, parent_name, symbol_path,
              start_byte, end_byte, start_line, end_line, start_column, end_column
       FROM source_ranges WHERE ${conditions.join(' AND ')}
       ORDER BY start_byte, end_byte, kind, symbol_path LIMIT ?`,
    )
    .all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map(mapRange);
}

/**
 * Resolve a symbol against the current persisted source index and return only
 * its bounded source. Stale or ambiguous lookups fail explicitly.
 */
export function readSourceSymbolRange(
  db: DatabaseSync,
  filePath: string,
  projectRoot: string,
  projectId: number,
  symbol: string,
  options: { kind?: SourceRangeKind; occurrence?: number; maxBytes?: number } = {},
): SourceSymbolRangeResult {
  const absolutePath = assertProjectPath(filePath, projectRoot, {
    mustExist: true,
    rejectIgnored: true,
  });
  const normalizedPath = relative(projectRoot, absolutePath).replace(/\\/g, '/');
  const file = db
    .prepare(
      `SELECT id FROM files WHERE project_id = ? AND (relative_path = ? OR path = ?) LIMIT 1`,
    )
    .get(projectId, normalizedPath, absolutePath) as { id: number } | undefined;
  if (!file) {
    throw new Error(
      `No indexed file found for '${normalizedPath}'. Run 'pm scan --full' before symbol retrieval.`,
    );
  }

  const bytes = readFileSync(absolutePath);
  const currentHash = sha256(bytes);
  const candidates = listIndexedSourceRanges(db, file.id, {
    sourceHash: currentHash,
    kind: options.kind,
    symbol,
  });
  if (candidates.length === 0) {
    const stale = listIndexedSourceRanges(db, file.id, { kind: options.kind, symbol }).length > 0;
    throw new Error(
      stale
        ? `The source range index for '${normalizedPath}' is stale. Run 'pm scan' and retry.`
        : `Symbol '${symbol}' was not found in the current source index for '${normalizedPath}'.`,
    );
  }
  const occurrence = options.occurrence ?? 1;
  if (!Number.isSafeInteger(occurrence) || occurrence < 1) {
    throw new Error('Symbol occurrence must be a positive integer.');
  }
  if (occurrence > candidates.length) {
    throw new Error(
      `Symbol '${symbol}' has ${candidates.length} indexed occurrence(s); occurrence ${occurrence} does not exist.`,
    );
  }
  if (candidates.length > 1 && options.occurrence === undefined) {
    throw new Error(
      `Symbol '${symbol}' is ambiguous (${candidates.length} occurrences). Pass occurrence: 1..${candidates.length}.`,
    );
  }

  const selected = candidates[occurrence - 1]!;
  const content = readSourceRange(
    filePath,
    projectRoot,
    selected.startByte,
    selected.endByte,
    options.maxBytes,
  );
  return {
    ...content,
    symbol: {
      kind: selected.kind,
      name: selected.name,
      parentName: selected.parentName,
      symbolPath: selected.symbolPath,
      startByte: selected.startByte,
      endByte: selected.endByte,
      startLine: selected.startLine,
      endLine: selected.endLine,
      startColumn: selected.startColumn,
      endColumn: selected.endColumn,
    },
  };
}

function ensureSourceRangeTable(db: DatabaseSync): void {
  db.exec(SOURCE_RANGE_TABLE_SQL);
}

function mapRange(row: Record<string, unknown>): IndexedSourceRange {
  return {
    id: Number(row.id),
    fileId: Number(row.file_id),
    projectId: Number(row.project_id),
    sourceHash: String(row.source_hash),
    kind: String(row.kind) as SourceRangeKind,
    name: String(row.name),
    parentName: row.parent_name === null ? null : String(row.parent_name),
    symbolPath: String(row.symbol_path),
    startByte: Number(row.start_byte),
    endByte: Number(row.end_byte),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    startColumn: Number(row.start_column),
    endColumn: Number(row.end_column),
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  switch (extname(filePath).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function createPositionMapper(source: string): PositionMapper {
  const lineStarts: number[] = [0];
  const lineStartBytes: number[] = [0];
  let byteOffset = 0;
  for (let index = 0; index < source.length;) {
    const codePoint = source.codePointAt(index)!;
    const charWidth = codePoint > 0xffff ? 2 : 1;
    const byteWidth = Buffer.byteLength(String.fromCodePoint(codePoint), 'utf8');
    if (source[index] === '\n') {
      lineStarts.push(index + charWidth);
      lineStartBytes.push(byteOffset + byteWidth);
    }
    byteOffset += byteWidth;
    index += charWidth;
  }

  const at = (characterOffset: number): Position => {
    const clamped = Math.max(0, Math.min(characterOffset, source.length));
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle]! <= clamped) low = middle + 1;
      else high = middle - 1;
    }
    const lineIndex = Math.max(0, high);
    const lineStart = lineStarts[lineIndex]!;
    return {
      byte:
        lineStartBytes[lineIndex]! + Buffer.byteLength(source.slice(lineStart, clamped), 'utf8'),
      line: lineIndex + 1,
      column: clamped - lineStart + 1,
    };
  };
  return { at };
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function namedNodeText(node: ts.Node): string | null {
  if (!('name' in node)) return null;
  const name = (node as ts.NamedDeclaration).name;
  if (!name || ts.isComputedPropertyName(name)) return null;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

function inferredFunctionName(node: ts.Node, sourceFile: ts.SourceFile): string {
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === node) {
    if (ts.isIdentifier(parent.name)) return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent) && parent.initializer === node) {
    const name = parent.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
  }
  return `anonymous@${lineOf(node, sourceFile)}`;
}

function findClassParent(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  let current = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current)) {
      return namedNodeText(current) ?? `class@${lineOf(current, sourceFile)}`;
    }
    current = current.parent;
  }
  return null;
}
