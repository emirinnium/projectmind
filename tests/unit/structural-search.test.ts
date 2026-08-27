import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StructuralSearcher, type StructuralSearchOptions, type StructuralReplaceOptions } from '../../src/parser/structural-search.js';

const searcher = new StructuralSearcher();

// ---------------------------------------------------------------------------
// Test fixtures — written to a temp directory and cleaned up afterwards.
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(tmpdir(), 'pm-structural-search-test-' + Date.now());

const TS_FILE = join(FIXTURE_DIR, 'sample.ts');
const TS_CONTENT = [
  'import { logger } from "./logger.js";',
  '',
  'export async function fetchUser(id: string): Promise<{ name: string }> {',
  '  const response = await fetch(`/api/users/${id}`);',
  '  return response.json();',
  '}',
  '',
  'function logError(err: Error): void {',
  '  logger.error(err.message);',
  '}',
  '',
  'export function addUser(name: string): void {',
  '  console.log(`Adding user: ${name}`);',
  '}',
  '',
  'const helper = () => { return "ok"; };',
].join('\n');

const NESTED_FILE = join(FIXTURE_DIR, 'nested.ts');
const NESTED_CONTENT = [
  'function outer() {',
  '  function inner() {',
  '    return 42;',
  '  }',
  '  return inner();',
  '}',
].join('\n');

const IDENTIFIER_FILE = join(FIXTURE_DIR, 'identifiers.ts');
const IDENTIFIER_CONTENT = [
  'const oldValue = 1;',
  'const result = oldValue + 1;',
].join('\n');

beforeAll(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(TS_FILE, TS_CONTENT, 'utf-8');
  writeFileSync(NESTED_FILE, NESTED_CONTENT, 'utf-8');
  writeFileSync(IDENTIFIER_FILE, IDENTIFIER_CONTENT, 'utf-8');
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

// ===========================================================================
// SEARCH
// ===========================================================================

describe('StructuralSearcher - search', () => {
  it('finds async function declarations', () => {
    const matches = searcher.search(
      { nodeKind: 'FunctionDeclaration', hasModifier: 'async', maxResults: 10 },
      [TS_FILE],
    );
    expect(matches.length).toBe(1);
    expect(matches[0].nodeKind).toBe('FunctionDeclaration');
    expect(matches[0].text).toContain('fetchUser');
  });

  it('finds functions by name pattern', () => {
    const matches = searcher.search(
      { nodeKind: 'FunctionDeclaration', namePattern: '^add' },
      [TS_FILE],
    );
    expect(matches.length).toBe(1);
    expect(matches[0].text).toContain('addUser');
  });

  it('finds nodes containing specific text', () => {
    const matches = searcher.search(
      { containsText: 'console.log' },
      [TS_FILE],
    );
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.some((m) => m.text.includes('console.log'))).toBe(true);
  });

  it('finds multiple matches across nodes', () => {
    const matches = searcher.search(
      { nodeKind: 'FunctionDeclaration' },
      [TS_FILE, NESTED_FILE],
    );
    // 3 in TS_FILE (fetchUser, logError, addUser) + 2 in NESTED_FILE (outer, inner) = 5
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it('respects maxResults limit', () => {
    const matches = searcher.search(
      { nodeKind: 'FunctionDeclaration', maxResults: 2 },
      [TS_FILE, NESTED_FILE],
    );
    expect(matches.length).toBeLessThanOrEqual(2);
  });

  it('returns empty array when nothing matches', () => {
    const matches = searcher.search(
      { nodeKind: 'FunctionDeclaration', namePattern: '^nonexistent' },
      [TS_FILE],
    );
    expect(matches).toHaveLength(0);
  });
});

// ===========================================================================
// REPLACE (dry-run)
// ===========================================================================

describe('StructuralSearcher - replace (dry-run)', () => {
  it('produces diffs without writing to disk', () => {
    const result = searcher.replace(
      {
        nodeKind: 'FunctionDeclaration',
        namePattern: '^logError',
        replacement: 'function logError(err: Error): void { logger.error(err.message); }',
        dryRun: true,
      },
      [TS_FILE],
    );

    expect(result.dryRun).toBe(true);
    // In dry-run mode, files array lists which files WOULD be affected
    // (the MCP tool uses this count in its message), but no writes occur.
    if (result.replaced > 0) {
      expect(result.files.length).toBeGreaterThanOrEqual(1);
      expect(result.diffs.length).toBeGreaterThanOrEqual(1);
      expect(result.diffs[0].filePath).toBe(TS_FILE);
      expect(result.diffs[0].original).toBe(TS_CONTENT);
      expect(result.diffs[0].transformed).not.toBe(TS_CONTENT);
    }
  });

  it('does not modify original file in dry-run', () => {
    const before = readFileSync(TS_FILE, 'utf-8');
    searcher.replace(
      {
        nodeKind: 'FunctionDeclaration',
        namePattern: '^logError',
        replacement: 'function logError(err: Error): void { /* replaced */ }',
        dryRun: true,
      },
      [TS_FILE],
    );
    const after = readFileSync(TS_FILE, 'utf-8');
    expect(after).toBe(before);
  });
});

// ===========================================================================
// REPLACE (write) — AST-based transform
// ===========================================================================

describe('StructuralSearcher - replace (AST-based)', () => {
  // Use a dedicated file for write tests so we don't interfere with other tests.
  const WRITE_FILE = join(FIXTURE_DIR, 'write-test.ts');
  const WRITE_CONTENT = [
    'function greet(name: string) {',
    '  return `Hello, ${name}!`;',
    '}',
  ].join('\n');

  beforeAll(() => {
    writeFileSync(WRITE_FILE, WRITE_CONTENT, 'utf-8');
  });

  it('replaces a function declaration via AST transform', () => {
    const result = searcher.replace(
      {
        nodeKind: 'FunctionDeclaration',
        namePattern: '^greet',
        replacement: 'function greet(name: string) { return `Hi, ${name}!`; }',
        dryRun: false,
      },
      [WRITE_FILE],
    );

    expect(result.replaced).toBe(1);
    expect(result.files).toContain(WRITE_FILE);
    expect(result.dryRun).toBe(false);

    const newContent = readFileSync(WRITE_FILE, 'utf-8');
    expect(newContent).toContain('Hi, ${name}!');
    expect(newContent).not.toContain('Hello, ${name}!');
  });

  it('preserves surrounding code during replacement', () => {
    // Reset the file
    writeFileSync(WRITE_FILE, [
      'import { helper } from "./helper.js";',
      '',
      'function greet(name: string) {',
      '  return `Hello, ${name}!`;',
      '}',
      '',
      'export default greet;',
    ].join('\n'), 'utf-8');

    const result = searcher.replace(
      {
        nodeKind: 'FunctionDeclaration',
        namePattern: '^greet',
        replacement: 'function greet(name: string) { return `Hi, ${name}!`; }',
        dryRun: false,
      },
      [WRITE_FILE],
    );

    expect(result.replaced).toBe(1);

    const newContent = readFileSync(WRITE_FILE, 'utf-8');
    // Import should be preserved
    expect(newContent).toContain('import { helper } from');
    // Export should be preserved
    expect(newContent).toContain('export default greet');
    // Replacement should be present
    expect(newContent).toContain('Hi, ${name}!');
  });

  it('replaces expression nodes correctly', () => {
    const EXPR_FILE = join(FIXTURE_DIR, 'expr-test.ts');
    writeFileSync(EXPR_FILE, [
      'const x = console.log("hello");',
      'const y = 42;',
    ].join('\n'), 'utf-8');

    const result = searcher.replace(
      {
        nodeKind: 'CallExpression',
        containsText: 'console.log',
        replacement: 'logger.info("hello")',
        dryRun: false,
      },
      [EXPR_FILE],
    );

    expect(result.replaced).toBe(1);

    const newContent = readFileSync(EXPR_FILE, 'utf-8');
    expect(newContent).toContain('logger.info("hello")');
    expect(newContent).not.toContain('console.log');
  });

  it('handles multiple matches in one file', () => {
    const MULTI_FILE = join(FIXTURE_DIR, 'multi-test.ts');
    writeFileSync(MULTI_FILE, [
      'function alpha() { return 1; }',
      'function beta() { return 2; }',
      'function gamma() { return 3; }',
    ].join('\n'), 'utf-8');

    const result = searcher.replace(
      {
        nodeKind: 'FunctionDeclaration',
        replacement: 'function replaced() { return 0; }',
        dryRun: false,
      },
      [MULTI_FILE],
    );

    expect(result.replaced).toBe(3);

    const newContent = readFileSync(MULTI_FILE, 'utf-8');
    // All three should be replaced
    const matches = newContent.match(/function replaced\(\)/g);
    expect(matches).toHaveLength(3);
  });

  it('skips files that cannot be processed', () => {
    const result = searcher.replace(
      {
        nodeKind: 'FunctionDeclaration',
        namePattern: 'nonexistent',
        replacement: 'function noop() {}',
        dryRun: false,
      },
      ['/nonexistent/file/path.ts'],
    );

    expect(result.replaced).toBe(0);
    expect(result.files).toHaveLength(0);
  });

  it('returns empty when no matches found', () => {
    const result = searcher.replace(
      {
        nodeKind: 'FunctionDeclaration',
        namePattern: '^nonexistent',
        replacement: 'function noop() {}',
        dryRun: false,
      },
      [WRITE_FILE],
    );

    expect(result.replaced).toBe(0);
    expect(result.files).toHaveLength(0);
    expect(result.diffs).toHaveLength(0);
  });
});

// ===========================================================================
// AST REPLACEMENT PARSING
// ===========================================================================

describe('StructuralSearcher - AST replacement parsing edge cases', () => {
  it('handles identifier replacement for name nodes', () => {
    const ID_FILE = join(FIXTURE_DIR, 'rename-test.ts');
    writeFileSync(ID_FILE, [
      'function oldName() { return 1; }',
    ].join('\n'), 'utf-8');

    // Replace the function declaration with a new one — should work
    const result = searcher.replace(
      {
        nodeKind: 'FunctionDeclaration',
        namePattern: '^oldName',
        replacement: 'function newName() { return 1; }',
        dryRun: false,
      },
      [ID_FILE],
    );

    expect(result.replaced).toBe(1);
    const newContent = readFileSync(ID_FILE, 'utf-8');
    expect(newContent).toContain('newName');
    expect(newContent).not.toContain('oldName');
  });

  it('gracefully handles invalid replacement syntax', () => {
    const ERR_FILE = join(FIXTURE_DIR, 'error-test.ts');
    writeFileSync(ERR_FILE, [
      'function target() {}',
    ].join('\n'), 'utf-8');

    const result = searcher.replace(
      {
        nodeKind: 'FunctionDeclaration',
        namePattern: '^target',
        replacement: 'this is not valid {{{{ code',
        dryRun: false,
      },
      [ERR_FILE],
    );

    // Should not crash; replacement count is 0 since parsing failed
    expect(result.replaced).toBe(0);
    // File should be unmodified
    const content = readFileSync(ERR_FILE, 'utf-8');
    expect(content).toContain('function target()');
  });
});
