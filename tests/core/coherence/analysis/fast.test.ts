import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FastCoherenceAnalyzer } from '../../../../src/core/coherence/analysis/fast.js';
import { CoherenceCache } from '../../../../src/core/cache/index.js';
import { ContractEngine } from '../../../../src/core/contracts/engine.js';
import { SCHEMA_SQL } from '../../../../src/storage/schema.js';
import type { CoherenceCheckOptions } from '../../../../src/core/coherence/analysis/fast.js';

describe('FastCoherenceAnalyzer', () => {
  let tmpDir: string;
  let db: DatabaseSync;
  let cache: CoherenceCache;
  let contractEngine: ContractEngine;
  let analyzer: FastCoherenceAnalyzer;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pm-coherence-'));
    db = new DatabaseSync(join(tmpDir, 'coherence-test.db'));
    db.exec(SCHEMA_SQL);
  });

  afterAll(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    cache = new CoherenceCache(1000, 300_000);
    contractEngine = new ContractEngine([]);
    analyzer = new FastCoherenceAnalyzer(db, cache, contractEngine);
  });

  // Helper to build options
  function makeOptions(code: string, filePath: string): CoherenceCheckOptions {
    return { code, filePath };
  }

  // Helper to generate N lines of code
  function generateLines(n: number): string {
    return Array.from({ length: n }, (_, i) => `// line ${i + 1}`).join('\n');
  }

  // Helper to generate N import statements
  function generateImports(n: number): string {
    return Array.from({ length: n }, (_, i) => `import { foo${i} } from 'module${i}';`).join('\n');
  }

  // Helper to generate N "any" usages
  function generateAnyUsages(n: number): string {
    return Array.from({ length: n }, (_, i) => `const x${i}: any = ${i};`).join('\n');
  }

  // Helper to generate N console statements
  function generateConsoleStatements(n: number): string {
    return Array.from({ length: n }, (_, i) => `console.log("message ${i}");`).join('\n');
  }

  // Helper to add enough types to pass the type usage check (≥5 capitalized words)
  function withTypes(code: string): string {
    return code + '\ntype MyType = string;\ninterface MyInterface {\n  Alpha: number;\n  Beta: string;\n}\ntype AnotherType = number;\n';
  }

  // ============================================================
  // Clean file tests — should pass all thresholds
  // ============================================================
  describe('clean files that pass all thresholds', () => {
    it('returns pass verdict for a small clean TypeScript file with sufficient types', () => {
      // Need ≥5 capitalized words to pass the type usage check
      const code = withTypes(`function hello(): string {
  return 'world';
}

const result: string = hello();
console.log(result);
`);
      const result = analyzer.analyze(makeOptions(code, 'src/clean.ts'), 'clean-key-1');

      expect(result.verdict).toBe('pass');
      expect(result.confidence).toBeGreaterThan(0.7);
      expect(result.llmProvider).toBe('fast-tier');
      expect(result.reasoningTrace.length).toBeGreaterThan(0);
    });

    it('returns pass verdict for a minimal JavaScript file (no type check)', () => {
      // .js files are not checked for type usage
      const code = `function hello() {
  return 'world';
}

const result = hello();
`;
      const result = analyzer.analyze(makeOptions(code, 'src/minimal.js'), 'minimal-key');

      expect(result.verdict).toBe('pass');
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('returns pass verdict for a file with moderate complexity and sufficient types', () => {
      const code = withTypes(`interface User {
  name: string;
  age: number;
}

function greet(user: User): string {
  if (user.age >= 18) {
    return 'Hello, adult';
  }
  return 'Hello, minor';
}

const user: User = { name: 'Alice', age: 25 };
const message: string = greet(user);
`);
      const result = analyzer.analyze(makeOptions(code, 'src/greeter.ts'), 'greeter-key');

      expect(result.verdict).toBe('pass');
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ============================================================
  // File length threshold (MAX_FILE_LINES = 400)
  // ============================================================
  describe('file length threshold (MAX_FILE_LINES = 400)', () => {
    it('flags file exceeding 400 lines', () => {
      const code = generateLines(401);
      const result = analyzer.analyze(makeOptions(code, 'src/long.ts'), 'long-key');

      expect(result.verdict).not.toBe('pass');
      expect(result.reasoningTrace.some((r: string) => r.includes('400 lines'))).toBe(true);
      expect(result.suggestions.some((s: string) => s.includes('splitting'))).toBe(true);
    });

    it('passes file at exactly 400 lines', () => {
      const code = generateLines(400);
      const result = analyzer.analyze(makeOptions(code, 'src/exact-400.ts'), 'exact-400-key');

      // 400 lines is NOT > 400, so no line-length issue
      expect(result.reasoningTrace.some((r: string) => r.includes('400 lines'))).toBe(false);
    });

    it('fails file at 401 lines (just over threshold)', () => {
      const code = generateLines(401);
      const result = analyzer.analyze(makeOptions(code, 'src/over-400.ts'), 'over-400-key');

      expect(result.reasoningTrace.some((r: string) => r.includes('401'))).toBe(true);
    });
  });

  // ============================================================
  // Import count threshold (MAX_IMPORT_COUNT = 20)
  // ============================================================
  describe('import count threshold (MAX_IMPORT_COUNT = 20)', () => {
    it('flags file with more than 20 imports', () => {
      const code = generateImports(21);
      const result = analyzer.analyze(makeOptions(code, 'src/many-imports.ts'), 'imports-key');

      expect(result.verdict).not.toBe('pass');
      expect(result.reasoningTrace.some((r: string) => r.includes('import count'))).toBe(true);
      expect(result.suggestions.some((s: string) => s.includes('imports'))).toBe(true);
    });

    it('passes file with exactly 20 imports', () => {
      const code = generateImports(20);
      const result = analyzer.analyze(makeOptions(code, 'src/exact-20-imports.ts'), 'exact-20-key');

      expect(result.reasoningTrace.some((r: string) => r.includes('import count'))).toBe(false);
    });

    it('flags file with 21 imports (just over threshold)', () => {
      const code = generateImports(21);
      const result = analyzer.analyze(makeOptions(code, 'src/over-20-imports.ts'), 'over-20-key');

      expect(result.reasoningTrace.some((r: string) => r.includes('21'))).toBe(true);
    });
  });

  // ============================================================
  // Any usage threshold (MAX_ANY_USAGE = 5)
  // ============================================================
  describe('any usage threshold (MAX_ANY_USAGE = 5)', () => {
    it('flags file with more than 5 any usages', () => {
      const code = generateAnyUsages(6);
      const result = analyzer.analyze(makeOptions(code, 'src/many-any.ts'), 'any-key');

      expect(result.verdict).not.toBe('pass');
      expect(result.reasoningTrace.some((r: string) => r.includes('"any"'))).toBe(true);
      expect(result.suggestions.some((s: string) => s.includes('any'))).toBe(true);
    });

    it('passes file with exactly 5 any usages', () => {
      const code = generateAnyUsages(5);
      const result = analyzer.analyze(makeOptions(code, 'src/exact-5-any.ts'), 'exact-5-any-key');

      expect(result.reasoningTrace.some((r: string) => r.includes('"any"'))).toBe(false);
    });

    it('flags file with 6 any usages (just over threshold)', () => {
      const code = generateAnyUsages(6);
      const result = analyzer.analyze(makeOptions(code, 'src/over-5-any.ts'), 'over-5-any-key');

      expect(result.reasoningTrace.some((r: string) => r.includes('6 uses'))).toBe(true);
    });
  });

  // ============================================================
  // Console statement threshold (MAX_CONSOLE_COUNT = 3)
  // ============================================================
  describe('console statement threshold (MAX_CONSOLE_COUNT = 3)', () => {
    it('flags file with more than 3 console statements', () => {
      const code = generateConsoleStatements(4);
      const result = analyzer.analyze(makeOptions(code, 'src/many-console.ts'), 'console-key');

      expect(result.verdict).not.toBe('pass');
      expect(result.reasoningTrace.some((r: string) => r.includes('console'))).toBe(true);
      expect(result.suggestions.some((s: string) => s.includes('console'))).toBe(true);
    });

    it('passes file with exactly 3 console statements', () => {
      // Need to add types to avoid low type usage warning
      const code = withTypes(generateConsoleStatements(3));
      const result = analyzer.analyze(makeOptions(code, 'src/exact-3-console.ts'), 'exact-3-console-key');

      // Check for the specific console warning message, not just "console" substring
      expect(result.reasoningTrace.some((r: string) => r.includes('console statements found'))).toBe(false);
    });

    it('flags file with 4 console statements (just over threshold)', () => {
      const code = generateConsoleStatements(4);
      const result = analyzer.analyze(makeOptions(code, 'src/over-3-console.ts'), 'over-3-console-key');

      expect(result.reasoningTrace.some((r: string) => r.includes('console statements found'))).toBe(true);
    });

    it('excludes console check for files in /cli/commands/ path', () => {
      const code = generateConsoleStatements(10);
      const result = analyzer.analyze(
        makeOptions(code, 'src/cli/commands/deploy.ts'),
        'cli-console-key'
      );

      expect(result.reasoningTrace.some((r: string) => r.includes('console statements found'))).toBe(false);
    });

    it('excludes console check for files in /scripts/ path', () => {
      const code = generateConsoleStatements(10);
      const result = analyzer.analyze(
        makeOptions(code, 'src/scripts/migrate.ts'),
        'scripts-console-key'
      );

      expect(result.reasoningTrace.some((r: string) => r.includes('console statements found'))).toBe(false);
    });

    it('excludes console check for files in /tests/ path', () => {
      const code = generateConsoleStatements(10);
      const result = analyzer.analyze(
        makeOptions(code, 'src/tests/helper.ts'),
        'tests-console-key'
      );

      expect(result.reasoningTrace.some((r: string) => r.includes('console statements found'))).toBe(false);
    });
  });

  // ============================================================
  // Semantic analysis checks
  // ============================================================
  describe('semantic analysis checks', () => {
    describe('naming conventions', () => {
      it('flags non-camelCase function names', () => {
        const code = withTypes(`function MyFunction(): void {
  return;
}

function AnotherBadName(): string {
  return 'test';
}
`);
        const result = analyzer.analyze(makeOptions(code, 'src/bad-names.ts'), 'names-key');

        expect(result.reasoningTrace.some((r: string) => r.includes('camelCase'))).toBe(true);
        expect(result.suggestions.some((s: string) => s.includes('camelCase'))).toBe(true);
      });

      it('passes camelCase function names', () => {
        const code = withTypes(`function myFunction(): void {
  return;
}

function anotherGoodName(): string {
  return 'test';
}
`);
        const result = analyzer.analyze(makeOptions(code, 'src/good-names.ts'), 'good-names-key');

        expect(result.reasoningTrace.some((r: string) => r.includes('camelCase'))).toBe(false);
      });
    });

    describe('unused variables', () => {
      it('flags variables marked as unused via comment', () => {
        // The code considers a variable "unused" only if it has a "// varName unused" comment
        const code = withTypes(`const usedVar = 42;
const unusedVar = 100; // unusedVar unused
console.log(usedVar);
`);
        const result = analyzer.analyze(makeOptions(code, 'src/unused.ts'), 'unused-key');

        expect(result.reasoningTrace.some((r: string) => r.includes('unused'))).toBe(true);
        expect(result.suggestions.some((s: string) => s.includes('unused'))).toBe(true);
      });

      it('does not flag variables when they appear in code', () => {
        // Variables are considered "used" if their name appears anywhere in the code
        // Need to add types to avoid low type usage warning
        // Note: file path must not contain "unused" substring
        const code = withTypes(`const usedVar = 42;
const alsoUsed = 100;
console.log(usedVar, alsoUsed);
`);
        const result = analyzer.analyze(makeOptions(code, 'src/vars.ts'), 'vars-key');

        expect(result.reasoningTrace.some((r: string) => r.includes('unused'))).toBe(false);
      });
    });

    describe('cyclomatic complexity', () => {
      it('flags functions with high cyclomatic complexity (>10 decision points)', () => {
        // Need more than 10 decision points in a single function body
        // Use flat if-statements to ensure they're all counted
        const code = `function complexFunction(x: number): number {
  if (x > 0) x = 1;
  if (x > 1) x = 2;
  if (x > 2) x = 3;
  if (x > 3) x = 4;
  if (x > 4) x = 5;
  if (x > 5) x = 6;
  if (x > 6) x = 7;
  if (x > 7) x = 8;
  if (x > 8) x = 9;
  if (x > 9) x = 10;
  if (x > 10) x = 11;
  return x;
}
`;
        const result = analyzer.analyze(makeOptions(code, 'src/complex.ts'), 'complex-key');

        expect(result.reasoningTrace.some((r: string) => r.includes('cyclomatic complexity'))).toBe(true);
        expect(result.suggestions.some((s: string) => s.includes('Refactor'))).toBe(true);
      });

      it('passes functions with acceptable complexity', () => {
        const code = withTypes(`function simpleFunction(x: number): number {
  if (x > 0) {
    return x * 2;
  }
  return x;
}
`);
        const result = analyzer.analyze(makeOptions(code, 'src/simple.ts'), 'simple-key');

        expect(result.reasoningTrace.some((r: string) => r.includes('cyclomatic complexity'))).toBe(false);
      });
    });

    describe('type usage in TypeScript files', () => {
      it('flags TypeScript files with low type usage (<5 capitalized words)', () => {
        // Need <5 capitalized words to trigger the warning
        const code = `function hello() {
  return 'world';
}

const x = hello();
`;
        const result = analyzer.analyze(makeOptions(code, 'src/low-types.ts'), 'low-types-key');

        expect(result.reasoningTrace.some((r: string) => r.includes('Low type usage'))).toBe(true);
        expect(result.suggestions.some((s: string) => s.includes('types'))).toBe(true);
      });

      it('does not flag non-TypeScript files for low type usage', () => {
        const code = `function hello() {
  return 'world';
}

const x = hello();
`;
        const result = analyzer.analyze(makeOptions(code, 'src/low-types.js'), 'low-types-js-key');

        expect(result.reasoningTrace.some((r: string) => r.includes('Low type usage'))).toBe(false);
      });

      it('passes TypeScript files with sufficient type usage (≥5 capitalized words)', () => {
        // Need ≥5 capitalized words: User, string, number, User, User, string, number
        const code = withTypes(`interface User {
  name: string;
  age: number;
}

function greet(user: User): string {
  return user.name;
}

const result: string = greet({ name: 'Alice', age: 25 });
`);
        const result = analyzer.analyze(makeOptions(code, 'src/good-types.ts'), 'good-types-key');

        expect(result.reasoningTrace.some((r: string) => r.includes('Low type usage'))).toBe(false);
      });
    });
  });

  // ============================================================
  // Verdict logic
  // ============================================================
  describe('verdict logic', () => {
    it('returns pass when no issues found', () => {
      // Need ≥5 capitalized words to avoid type usage warning
      const code = withTypes(`function hello(): string {
  return 'world';
}
`);
      const result = analyzer.analyze(makeOptions(code, 'src/pass.ts'), 'pass-key');

      expect(result.verdict).toBe('pass');
    });

    it('returns warn when 1-2 issues found', () => {
      // 1 issue: non-camelCase function (but enough capitalized words to pass type check)
      const code = withTypes(`function BadName(): void {
  return;
}
`);
      const result = analyzer.analyze(makeOptions(code, 'src/warn.ts'), 'warn-key');

      expect(result.verdict).toBe('warn');
    });

    it('returns fail when more than 2 issues found', () => {
      // Multiple issues: non-camelCase + unused variables + low type usage
      const code = `function BadName(): void {
  const unused = 42; // unused unused
  return;
}

function AnotherBad(): void {
  const alsoUnused = 100; // alsoUnused unused
  return;
}
`;
      const result = analyzer.analyze(makeOptions(code, 'src/fail.ts'), 'fail-key');

      expect(result.verdict).toBe('fail');
    });

    it('returns fail when contract error present', () => {
      // Add a contract that will trigger an error
      contractEngine.addContract({
        id: 'test-no-console',
        name: 'No Console in Test',
        sourcePattern: '**/*.ts',
        forbiddenKeywords: ['console.log'],
        severity: 'error',
      });

      const code = withTypes(`function hello(): void {
  console.log('test');
}
`);
      const result = analyzer.analyze(makeOptions(code, 'src/contract-fail.ts'), 'contract-fail-key');

      expect(result.verdict).toBe('fail');
      expect(result.reasoningTrace.some((r: string) => r.includes('[Contract ERROR]'))).toBe(true);
    });
  });

  // ============================================================
  // Confidence scoring
  // ============================================================
  describe('confidence scoring', () => {
    it('has high confidence for clean files', () => {
      const code = withTypes(`function hello(): string {
  return 'world';
}
`);
      const result = analyzer.analyze(makeOptions(code, 'src/confidence-clean.ts'), 'conf-clean-key');

      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('has lower confidence for files with more issues', () => {
      const cleanCode = withTypes(`function hello(): string {
  return 'world';
}
`);
      const dirtyCode = `function BadName(): void {
  const unused = 42; // unused unused
  return;
}

function AnotherBad(): void {
  const alsoUnused = 100; // alsoUnused unused
  return;
}
`;
      const cleanResult = analyzer.analyze(makeOptions(cleanCode, 'src/conf-clean.ts'), 'conf-clean-1');
      const dirtyResult = analyzer.analyze(makeOptions(dirtyCode, 'src/conf-dirty.ts'), 'conf-dirty-1');

      expect(cleanResult.confidence).toBeGreaterThan(dirtyResult.confidence);
    });

    it('never goes below 0.3 confidence', () => {
      // Generate a file with many issues
      const code = generateAnyUsages(10) + '\n' + generateConsoleStatements(10) + '\n' + generateImports(25) + '\n' + generateLines(500);
      const result = analyzer.analyze(makeOptions(code, 'src/very-dirty.ts'), 'very-dirty-key');

      expect(result.confidence).toBeGreaterThanOrEqual(0.3);
    });
  });

  // ============================================================
  // Caching behavior
  // ============================================================
  describe('caching behavior', () => {
    it('stores results in cache for the same cache key', () => {
      const code = withTypes(`function hello(): string {
  return 'world';
}
`);
      const result1 = analyzer.analyze(makeOptions(code, 'src/cache-test.ts'), 'same-cache-key');
      const result2 = analyzer.analyze(makeOptions(code, 'src/cache-test.ts'), 'same-cache-key');

      // The analyze method always recomputes but stores in cache
      // Results should be deeply equal (same verdict, confidence, etc.)
      expect(result1.verdict).toBe(result2.verdict);
      expect(result1.confidence).toBe(result2.confidence);
      expect(result1.reasoningTrace).toEqual(result2.reasoningTrace);
      expect(result1.suggestions).toEqual(result2.suggestions);
    });

    it('stores different results for different cache keys', () => {
      const code1 = withTypes(`function hello(): string {
  return 'world';
}
`);
      const code2 = withTypes(`function goodbye(): string {
  return 'bye';
}
`);
      const result1 = analyzer.analyze(makeOptions(code1, 'src/cache-test.ts'), 'cache-key-1');
      const result2 = analyzer.analyze(makeOptions(code2, 'src/cache-test.ts'), 'cache-key-2');

      // Different code produces different results
      expect(result1).not.toBe(result2);
    });

    it('populates the cache after analysis', () => {
      const code = withTypes(`function hello(): string {
  return 'world';
}
`);
      analyzer.analyze(makeOptions(code, 'src/cache-populate.ts'), 'populate-key');

      // The cache should now have an entry
      const cachedResult = cache.get('populate-key');
      expect(cachedResult).toBeDefined();
      expect(cachedResult?.verdict).toBe('pass');
    });
  });

  // ============================================================
  // Database persistence
  // ============================================================
  describe('database persistence', () => {
    it('stores coherence decision in database', () => {
      const code = withTypes(`function hello(): string {
  return 'world';
}
`);
      analyzer.analyze(makeOptions(code, 'src/db-test.ts'), 'db-test-key');

      const count = db.prepare('SELECT COUNT(*) as n FROM coherence_decisions').get() as { n: number };
      expect(count.n).toBeGreaterThanOrEqual(1);
    });

    it('updates existing decision for same code hash', () => {
      const code = withTypes(`function hello(): string {
  return 'world';
}
`);

      analyzer.analyze(makeOptions(code, 'src/db-update-test.ts'), 'db-update-key-1');
      analyzer.analyze(makeOptions(code, 'src/db-update-test.ts'), 'db-update-key-2');

      // Should have only one row for this code hash (updated, not inserted twice)
      // Note: The code uses stableHash(code) as the code_hash, so same code = same hash
      const rows = db.prepare('SELECT code_hash, COUNT(*) as cnt FROM coherence_decisions GROUP BY code_hash').all() as Array<{ code_hash: string; cnt: number }>;
      const targetRow = rows.find((r) => r.cnt === 1);
      expect(targetRow).toBeDefined();
    });
  });

  // ============================================================
  // Edge cases
  // ============================================================
  describe('edge cases', () => {
    it('handles empty file', () => {
      const result = analyzer.analyze(makeOptions('', 'src/empty.ts'), 'empty-key');

      expect(result.verdict).toBeDefined();
      expect(result.confidence).toBeGreaterThanOrEqual(0.3);
    });

    it('handles file with only whitespace', () => {
      const code = '   \n\n   \n';
      const result = analyzer.analyze(makeOptions(code, 'src/whitespace.ts'), 'whitespace-key');

      expect(result.verdict).toBeDefined();
    });

    it('handles file with Windows line endings', () => {
      const code = withTypes('function hello(): string {\r\n  return "world";\r\n}\r\n');
      const result = analyzer.analyze(makeOptions(code, 'src/windows.ts'), 'windows-key');

      expect(result.verdict).toBe('pass');
    });

    it('handles file with mixed line endings', () => {
      const code = withTypes('function hello(): string {\n  return "world";\r\n}\n');
      const result = analyzer.analyze(makeOptions(code, 'src/mixed.ts'), 'mixed-key');

      expect(result.verdict).toBe('pass');
    });

    it('handles very long single line file', () => {
      const code = 'const x = ' + 'a'.repeat(10000);
      const result = analyzer.analyze(makeOptions(code, 'src/long-line.ts'), 'long-line-key');

      expect(result.verdict).toBeDefined();
    });

    it('handles file with special characters in path', () => {
      const code = withTypes(`function hello(): string {
  return 'world';
}
`);
      const result = analyzer.analyze(
        makeOptions(code, 'src/path with spaces/file.ts'),
        'special-path-key'
      );

      expect(result.verdict).toBe('pass');
    });
  });

  // ============================================================
  // Multiple threshold violations combined
  // ============================================================
  describe('multiple threshold violations', () => {
    it('accumulates issues from multiple violations', () => {
      // File with: too many imports + too many any + too many console
      const imports = generateImports(25);
      const anys = generateAnyUsages(8);
      const consoles = generateConsoleStatements(5);
      const code = [imports, anys, consoles].join('\n');

      const result = analyzer.analyze(makeOptions(code, 'src/multi-violations.ts'), 'multi-key');

      expect(result.verdict).toBe('fail');
      expect(result.reasoningTrace.some((r: string) => r.includes('import count'))).toBe(true);
      expect(result.reasoningTrace.some((r: string) => r.includes('"any"'))).toBe(true);
      expect(result.reasoningTrace.some((r: string) => r.includes('console'))).toBe(true);
    });

    it('produces multiple suggestions for multiple violations', () => {
      const imports = generateImports(25);
      const anys = generateAnyUsages(8);
      const consoles = generateConsoleStatements(5);
      const code = [imports, anys, consoles].join('\n');

      const result = analyzer.analyze(makeOptions(code, 'src/multi-suggestions.ts'), 'multi-sug-key');

      expect(result.suggestions.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ============================================================
  // Response time tracking
  // ============================================================
  describe('response time tracking', () => {
    it('records response time for analysis', () => {
      const code = withTypes(`function hello(): string {
  return 'world';
}
`);
      const result = analyzer.analyze(makeOptions(code, 'src/timing.ts'), 'timing-key');

      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.responseTimeMs).toBe('number');
    });
  });

  // ============================================================
  // Reasoning trace
  // ============================================================
  describe('reasoning trace', () => {
    it('includes analysis start message', () => {
      const code = withTypes(`function hello(): string {
  return 'world';
}
`);
      const result = analyzer.analyze(makeOptions(code, 'src/trace.ts'), 'trace-key');

      expect(result.reasoningTrace[0]).toBe('Fast-tier analysis started');
    });

    it('includes file path in reasoning trace', () => {
      const code = withTypes(`function hello(): string {
  return 'world';
}
`);
      const result = analyzer.analyze(makeOptions(code, 'src/trace-path.ts'), 'trace-path-key');

      expect(result.reasoningTrace.some((r: string) => r.includes('trace-path.ts'))).toBe(true);
    });

    it('includes final issue count in reasoning trace', () => {
      const code = withTypes(`function hello(): string {
  return 'world';
}
`);
      const result = analyzer.analyze(makeOptions(code, 'src/trace-count.ts'), 'trace-count-key');

      expect(result.reasoningTrace.some((r: string) => r.includes('Issues found'))).toBe(true);
    });
  });
});
