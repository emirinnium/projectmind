import { reportSuppressedError } from '../../../src/utils/errors.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  IntentEngine,
  classifyTask,
  createKgGraphAdapter,
  cosineSimilarity,
  TASK_KEYWORDS,
} from '../../../src/core/search/intent-engine.js';
import type { IntentQuery } from '../../../src/core/search/types.js';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stableHash } from '../../../src/utils/hash.js';

describe('IntentEngine WP1', () => {
  const engine = new IntentEngine();

  describe('F1 backward compat and spec', () => {
    it('deprecated text alias works', () => {
      const q: IntentQuery = { text: 'find auth' };
      expect(engine.classifyIntent(q)).toBe('read');
    });
    it('naturalLanguage + structuralHints + expectedOutputs accepted', () => {
      const q: IntentQuery = {
        naturalLanguage: 'validate login',
        structuralHints: ['auth'],
        expectedOutputs: ['test'],
      };
      expect(engine.classifyIntent(q)).toBe('validate');
    });
    it('throws if neither naturalLanguage nor text', () => {
      expect(() => engine.classifyIntent({})).toThrow();
    });
  });

  describe('F2 task classifier', () => {
    it('bug fix for fix/bug/error/crash', () => {
      expect(classifyTask('fix crash in auth')).toBe('bug fix');
      expect(classifyTask('bug in login')).toBe('bug fix');
    });
    it('feature for add/new/feature/implement/support', () => {
      expect(classifyTask('add new feature')).toBe('feature');
      expect(classifyTask('implement support')).toBe('feature');
    });
    it('refactor for refactor/cleanup/restructure/extract/simplify', () => {
      expect(classifyTask('refactor auth layer')).toBe('refactor');
      expect(classifyTask('simplify code')).toBe('refactor');
    });
    it('test for test/coverage/spec/assert', () => {
      expect(classifyTask('add test coverage')).toBe('test');
      expect(classifyTask('spec for login')).toBe('test');
    });
    it('default feature when ambiguous', () => {
      expect(classifyTask('hello world')).toBe('feature');
    });
  });

  describe('F3 intentScore on file content', () => {
    const tmpDir = join(tmpdir(), 'intent-test-' + Date.now());
    beforeAll(() => {
      mkdirSync(tmpDir, { recursive: true });
    });
    afterAll(() => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch (error) {
        reportSuppressedError(
          error,
          'Intentional test fallback tests/core/search/intent-engine.test.ts:65',
        );
        /* ignore */
      }
    });

    it('ranks validate-heavy file above unrelated for validate query', () => {
      const validateFile = join(tmpDir, 'validate.ts');
      const unrelatedFile = join(tmpDir, 'unrelated.ts');
      writeFileSync(
        validateFile,
        'if (x) throw new Error("bad"); assert(true); z.object({}); isString(x);',
      );
      writeFileSync(unrelatedFile, 'const a = 1; console.log(a);');
      const scoreValidate = engine.intentScore('validate', validateFile);
      const scoreUnrelated = engine.intentScore('validate', unrelatedFile);
      expect(scoreValidate).toBeGreaterThan(scoreUnrelated);
    });
  });

  describe('F4 semantic + lexical fallback', () => {
    it('hybrid weights sum to configured defaults', () => {
      expect(
        engine.weights.semantic + engine.weights.structural + engine.weights.intent,
      ).toBeCloseTo(1, 5);
    });
    it('lexical fallback when embedding provider absent (stub)', async () => {
      const stubEngine = new IntentEngine({
        weights: { semantic: 0.4, structural: 0.3, intent: 0.3 },
      });
      const tmpDir = join(tmpdir(), 'lexical-test-' + Date.now());
      mkdirSync(tmpDir, { recursive: true });
      // Use non-existent file so file embedding fails -> lexical fallback
      const badPath = join(tmpDir, 'nonexistent.ts');
      const res = await stubEngine.computeSemanticScore('read file sync', badPath);
      expect(res.source).toBe('lexical');
      expect(res.score).toBeGreaterThanOrEqual(0);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('keeps measured graph similarity instead of replacing it with rank decay', () => {
      const results = engine.deriveSemanticFromSimilar([
        { path: 'src/strong.ts', score: 0.91 },
        { path: 'src/unknown.ts' },
      ]);

      expect(results[0]).toMatchObject({
        path: 'src/strong.ts',
        score: 0.91,
        semanticEvidence: 'measured',
      });
      expect(results[1]).toMatchObject({
        path: 'src/unknown.ts',
        score: 0.85,
        semanticEvidence: 'rank-derived',
      });
    });

    it('does not emit non-finite cosine scores', () => {
      expect(cosineSimilarity([1, Number.NaN], [1, 1])).toBe(0);
      expect(cosineSimilarity([Number.POSITIVE_INFINITY], [1])).toBe(0);
      expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
      expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    });

    it('adapter computes measured similarity from persisted vectors when available', () => {
      const adapter = createKgGraphAdapter({
        getFileByPath: (path) => ({ id: 7, path, hash: 'indexed-hash' }),
        findSimilarFiles: () => [{ id: 7, relativePath: 'src/measured.ts' }],
        getFileEmbedding: () => [1, 0],
      });

      const results = adapter.findSimilarFiles?.([1, 0], 0.5, 5);
      expect(results).toEqual([{ path: 'src/measured.ts', score: 1 }]);
      expect(adapter.getFileByPath('src/measured.ts')).toMatchObject({ hash: 'indexed-hash' });
    });
  });

  describe('F5 structural and snippet', () => {
    it('snippet contains file content not query text', async () => {
      const tmpDir = join(tmpdir(), 'snippet-test-' + Date.now());
      mkdirSync(tmpDir, { recursive: true });
      const f = join(tmpDir, 'snippet.ts');
      writeFileSync(f, 'export const foo = 1;\nexport const bar = 2;');
      const results = await engine.search(
        { naturalLanguage: 'find foo', filePath: f },
        {
          getFileByPath: (p: string) => ({ id: 1, path: p }),
          getImports: () => [{ source: f, named: [], kind: 'default' }],
        },
        5,
      );
      const r = results.find((x) => x.filePath === f);
      expect(r).toBeDefined();
      if (r) {
        expect(r.snippet).not.toContain('find foo');
        expect(r.snippet!.length).toBeGreaterThan(0);
      }
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // Path traversal guard: client-supplied filePath (e.g. MCP search_intent)
  // must never read OUTSIDE the configured projectRoot.
  describe('path traversal guard (projectRoot containment)', () => {
    let parent: string;
    let root: string;

    beforeAll(() => {
      parent = mkdtempSync(join(tmpdir(), 'pm-traversal-'));
      root = join(parent, 'project');
      mkdirSync(root, { recursive: true });
      // Marker content full of 'read' markers so any leak scores > 0.
      writeFileSync(
        join(parent, 'SECRET.txt'),
        'readFileSync(secret); readFileSync(secret); readFileSync(secret);',
      );
      writeFileSync(join(root, 'inside.ts'), 'readFileSync(x); readFileSync(y);');
    });

    afterAll(() => {
      try {
        rmSync(parent, { recursive: true, force: true });
      } catch (error) {
        reportSuppressedError(
          error,
          'Intentional test fallback tests/core/search/intent-engine.test.ts:186',
        );
        /* ignore */
      }
    });

    it('never reads files outside projectRoot via ../ escape', () => {
      const rooted = new IntentEngine({ projectRoot: root });
      // '../SECRET.txt' resolves OUTSIDE the root — must score 0 (unreadable).
      expect(rooted.intentScore('read', '../SECRET.txt')).toBe(0);
      // Deeper escape chains are also confined.
      expect(rooted.intentScore('read', '../../etc/passwd')).toBe(0);
    });

    it('rejects absolute paths outside projectRoot', () => {
      const rooted = new IntentEngine({ projectRoot: root });
      expect(rooted.intentScore('read', join(parent, 'SECRET.txt'))).toBe(0);
    });

    it('still reads files inside projectRoot (relative + absolute)', () => {
      const rooted = new IntentEngine({ projectRoot: root });
      expect(rooted.intentScore('read', 'inside.ts')).toBeGreaterThan(0);
      expect(rooted.intentScore('read', join(root, 'inside.ts'))).toBeGreaterThan(0);
    });

    it('computeSemanticScore degrades to zero lexical score on escape attempts', async () => {
      const rooted = new IntentEngine({ projectRoot: root });
      const res = await rooted.computeSemanticScore('readFileSync secret', '../SECRET.txt');
      expect(res.score).toBe(0);
    });

    it('search snippets never leak content from outside projectRoot', async () => {
      const rooted = new IntentEngine({ projectRoot: root });
      const results = await rooted.search(
        { naturalLanguage: 'read the secret', filePath: '../SECRET.txt' },
        { getFileByPath: () => null },
        5,
      );
      for (const r of results) {
        expect(r.snippet ?? '').not.toContain('readFileSync(secret)');
      }
    });

    it('penalizes a stale indexed hash and accepts a current indexed hash', () => {
      const rooted = new IntentEngine({ projectRoot: root });
      const content = readFileSync(join(root, 'inside.ts'), 'utf8');
      const freshGraph = {
        getFileByPath: () => ({ id: 1, path: 'inside.ts', hash: stableHash(content) }),
      };
      const staleGraph = {
        getFileByPath: () => ({ id: 1, path: 'inside.ts', hash: stableHash('old content') }),
      };
      expect(rooted.getFreshnessScore('inside.ts', freshGraph)).toBe(1);
      expect(rooted.getFreshnessScore('inside.ts', staleGraph)).toBe(0);
    });
  });
});
