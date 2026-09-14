import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SCHEMA_SQL } from '../../../src/storage/schema.js';
import {
  listIndexedSourceRanges,
  readSourceSymbolRange,
  rebuildSourceRangeIndex,
} from '../../../src/core/retrieval/source-index.js';

describe('persistent source byte/symbol index', () => {
  it('persists UTF-8 coordinates and reads an exact class method range', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-source-index-'));
    const filePath = join(root, 'symbols.ts');
    const source = 'const café = 1;\r\nclass Greeter {\r\n  greet() { return "ok"; }\r\n}\r\n';
    writeFileSync(filePath, source, 'utf8');
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (1, ?, ?)').run('test', root);
    db.prepare(
      'INSERT INTO files (id, project_id, path, relative_path, language, size_bytes, hash) VALUES (1, 1, ?, ?, ?, ?, ?)',
    ).run(filePath, 'symbols.ts', 'typescript', Buffer.byteLength(source), 'unused');

    const indexed = rebuildSourceRangeIndex(db, 1, 1, filePath, source);
    expect(indexed).toBeGreaterThan(2);
    const method = listIndexedSourceRanges(db, 1, { kind: 'method', symbol: 'greet' });
    expect(method).toHaveLength(1);
    expect(method[0]?.startByte).toBeGreaterThan(Buffer.byteLength('const café = 1;\r\n'));

    const result = readSourceSymbolRange(db, 'symbols.ts', root, 1, 'greet', { kind: 'method' });
    expect(result.content).toBe('greet() { return "ok"; }');
    expect(result.symbol.symbolPath).toBe('Greeter.greet');
    expect(result.lineEnding).toBe('crlf');
    db.close();
  });

  it('rejects stale and ambiguous indexed lookups instead of guessing', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-source-index-'));
    const filePath = join(root, 'stale.ts');
    const source = 'function run() { return 1; }\nfunction run() { return 2; }\n';
    writeFileSync(filePath, source, 'utf8');
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (1, ?, ?)').run('test', root);
    db.prepare(
      'INSERT INTO files (id, project_id, path, relative_path, language, size_bytes, hash) VALUES (1, 1, ?, ?, ?, ?, ?)',
    ).run(filePath, 'stale.ts', 'typescript', Buffer.byteLength(source), 'unused');
    rebuildSourceRangeIndex(db, 1, 1, filePath, source);

    expect(() => readSourceSymbolRange(db, 'stale.ts', root, 1, 'run')).toThrow(/ambiguous/);
    expect(
      readSourceSymbolRange(db, 'stale.ts', root, 1, 'run', { occurrence: 2 }).content,
    ).toContain('return 2');

    writeFileSync(filePath, source.replace('return 2', 'return 3'), 'utf8');
    expect(() => readSourceSymbolRange(db, 'stale.ts', root, 1, 'run', { occurrence: 1 })).toThrow(
      /stale/,
    );
    db.close();
  });
});
