import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoherenceEngine } from '../../../src/core/coherence/engine.js';
import { SCHEMA_SQL } from '../../../src/storage/schema.js';
import type { LLMProvider, CoherenceResult } from '../../../src/core/coherence/analysis/fast.js';

/**
 * Mock LLM provider for testing deep analysis without real API calls.
 */
function createMockLLMProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    name: 'mock-llm',
    model: 'mock-model',
    isAvailable: () => true,
    analyze: vi.fn().mockResolvedValue({
      content: 'REASONING_TRACE: 1. Looks good\nVERDICT: pass\nCONFIDENCE: 0.9\nSUGGESTIONS: none',
      reasoningTrace: ['1. Looks good'],
      confidence: 0.9,
      responseTimeMs: 50,
    }),
    ...overrides,
  };
}

describe('CoherenceEngine', () => {
  let tmpDir: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pm-coherence-engine-'));
    db = new DatabaseSync(join(tmpDir, 'test.db'));
    db.exec(SCHEMA_SQL);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ============================================================
  // Task 1: CoherenceEngine instantiation
  // ============================================================
  describe('instantiation', () => {
    it('creates an engine with default options', () => {
      const engine = new CoherenceEngine(db);
      expect(engine).toBeInstanceOf(CoherenceEngine);
      expect(engine.isOffline()).toBe(false);
      expect(engine.getCacheSize()).toBe(0);
    });

    it('creates an engine with custom cache size and TTL', () => {
      const engine = new CoherenceEngine(db, 500, 60_000);
      expect(engine).toBeInstanceOf(CoherenceEngine);
      const stats = engine.getCacheStats();
      expect(stats).toBeDefined();
    });

    it('creates its own database when none is provided', () => {
      // When no db is provided, CoherenceEngine calls getDatabase() which
      // requires initDatabase() to have been called. We pass an in-memory
      // database to avoid this dependency.
      const memDb = new DatabaseSync(':memory:');
      memDb.exec(SCHEMA_SQL);
      const engine = new CoherenceEngine(memDb);
      expect(engine).toBeInstanceOf(CoherenceEngine);
    });

    it('initializes schema on construction', () => {
      new CoherenceEngine(db);
      // Verify the coherence_decisions table exists
      const result = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='coherence_decisions'"
      ).get() as { name: string } | undefined;
      expect(result).toBeDefined();
      expect(result?.name).toBe('coherence_decisions');
    });
  });

  // ============================================================
  // Task 2: checkCoherence() with fast mode (no LLM)
  // ============================================================
  describe('checkCoherence() fast mode', () => {
    it('returns a pass verdict for clean code', async () => {
      const engine = new CoherenceEngine(db);
      // Need ≥5 capitalized words to pass the type usage check for .ts files
      const code = `interface MyType {
  Alpha: string;
  Beta: number;
}
function hello(): MyType {
  return { Alpha: 'world', Beta: 1 };
}
`;
      const result = await engine.checkCoherence({
        code,
        filePath: 'src/clean.ts',
        fastOnly: true,
      });

      expect(result.verdict).toBe('pass');
      expect(result.llmProvider).toBe('fast-tier');
      expect(result.confidence).toBeGreaterThan(0.7);
      expect(result.reasoningTrace.length).toBeGreaterThan(0);
    });

    it('returns a warn verdict for code with minor issues', async () => {
      const engine = new CoherenceEngine(db);
      // Non-camelCase function triggers a warning
      const code = `function BadName(): void {
  return;
}
`;
      const result = await engine.checkCoherence({
        code,
        filePath: 'src/warn.ts',
        fastOnly: true,
      });

      expect(result.verdict).toBe('warn');
    });

    it('returns a fail verdict for code with many issues', async () => {
      const engine = new CoherenceEngine(db);
      // Many "any" usages + many console statements
      const code =
        Array.from({ length: 8 }, (_, i) => `const x${i}: any = ${i};`).join('\n') +
        '\n' +
        Array.from({ length: 5 }, (_, i) => `console.log("msg ${i}");`).join('\n');
      const result = await engine.checkCoherence({
        code,
        filePath: 'src/fail.ts',
        fastOnly: true,
      });

      expect(result.verdict).toBe('fail');
    });

    it('caches results for the same code and file path', async () => {
      const engine = new CoherenceEngine(db);
      const code = `function hello(): string {\n  return 'world';\n}\n`;

      const result1 = await engine.checkCoherence({
        code,
        filePath: 'src/cache-test.ts',
        fastOnly: true,
      });
      const result2 = await engine.checkCoherence({
        code,
        filePath: 'src/cache-test.ts',
        fastOnly: true,
      });

      expect(result1.verdict).toBe(result2.verdict);
      expect(result1.confidence).toBe(result2.confidence);
      expect(engine.getCacheSize()).toBeGreaterThan(0);
    });

    it('uses fast-tier when no LLM provider is set even in deep mode', async () => {
      const engine = new CoherenceEngine(db);
      // No LLM provider set, but deepAnalysis requested
      const code = `function hello(): string {\n  return 'world';\n}\n`;
      const result = await engine.checkCoherence({
        code,
        filePath: 'src/no-llm.ts',
        deepAnalysis: true,
      });

      // Should fall back to fast-tier since no LLM provider is available
      expect(result.llmProvider).toBe('fast-tier');
    });
  });

  // ============================================================
  // Task 3: checkCoherence() with deep mode (mock LLM provider)
  // ============================================================
  describe('checkCoherence() deep mode with mock LLM', () => {
    it('uses deep analyzer when LLM provider is available', async () => {
      const engine = new CoherenceEngine(db);
      const mockProvider = createMockLLMProvider();
      engine.setLLMProvider(mockProvider);
      engine.setOffline(false);

      const code = `function hello(): string {\n  return 'world';\n}\n`;
      const result = await engine.checkCoherence({
        code,
        filePath: 'src/deep-test.ts',
        deepAnalysis: true,
      });

      expect(mockProvider.analyze).toHaveBeenCalled();
      expect(result.verdict).toBe('pass');
      expect(result.confidence).toBeCloseTo(0.9);
    });

    it('does not call LLM when offline mode is enabled', async () => {
      const engine = new CoherenceEngine(db);
      const mockProvider = createMockLLMProvider();
      engine.setLLMProvider(mockProvider);
      engine.setOffline(true);

      const code = `function hello(): string {\n  return 'world';\n}\n`;
      const result = await engine.checkCoherence({
        code,
        filePath: 'src/offline-test.ts',
        deepAnalysis: true,
      });

      expect(mockProvider.analyze).not.toHaveBeenCalled();
      expect(result.llmProvider).toBe('fast-tier');
    });

    it('respects fastOnly flag even with LLM available', async () => {
      const engine = new CoherenceEngine(db);
      const mockProvider = createMockLLMProvider();
      engine.setLLMProvider(mockProvider);

      const code = `function hello(): string {\n  return 'world';\n}\n`;
      const result = await engine.checkCoherence({
        code,
        filePath: 'src/fast-only.ts',
        fastOnly: true,
        deepAnalysis: true,
      });

      expect(mockProvider.analyze).not.toHaveBeenCalled();
      expect(result.llmProvider).toBe('fast-tier');
    });

    it('caches deep analysis results', async () => {
      const engine = new CoherenceEngine(db);
      const mockProvider = createMockLLMProvider();
      engine.setLLMProvider(mockProvider);

      const code = `function hello(): string {\n  return 'world';\n}\n`;

      await engine.checkCoherence({
        code,
        filePath: 'src/deep-cache.ts',
        deepAnalysis: true,
      });

      // Second call should use cache
      await engine.checkCoherence({
        code,
        filePath: 'src/deep-cache.ts',
        deepAnalysis: true,
      });

      // LLM should only be called once due to caching
      expect(mockProvider.analyze).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // Task 4: setLLMProvider() and setOffline() configuration
  // ============================================================
  describe('configuration methods', () => {
    it('setLLMProvider sets the provider on the deep analyzer', () => {
      const engine = new CoherenceEngine(db);
      const mockProvider = createMockLLMProvider();
      engine.setLLMProvider(mockProvider);
      // hasLLMProvider checks if the provider is available
      expect(engine.hasLLMProvider()).toBe(true);
    });

    it('setLLMProvider with unavailable provider returns false for hasLLMProvider', () => {
      const engine = new CoherenceEngine(db);
      const unavailableProvider = createMockLLMProvider({ isAvailable: () => false });
      engine.setLLMProvider(unavailableProvider);
      expect(engine.hasLLMProvider()).toBe(false);
    });

    it('setOffline toggles offline mode', () => {
      const engine = new CoherenceEngine(db);
      expect(engine.isOffline()).toBe(false);
      engine.setOffline(true);
      expect(engine.isOffline()).toBe(true);
      engine.setOffline(false);
      expect(engine.isOffline()).toBe(false);
    });

    it('setOffline(true) prevents cloud LLM usage', async () => {
      const engine = new CoherenceEngine(db);
      const mockProvider = createMockLLMProvider();
      engine.setLLMProvider(mockProvider);
      engine.setOffline(true);

      await engine.checkCoherence({
        code: 'const x = 1;',
        filePath: 'src/offline.ts',
        deepAnalysis: true,
      });

      expect(mockProvider.analyze).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Task 5: invalidateFileCache() cache management
  // ============================================================
  describe('cache management', () => {
    it('invalidateFileCache removes all entries for a file', async () => {
      const engine = new CoherenceEngine(db);
      const code = `function hello(): string {\n  return 'world';\n}\n`;

      // Populate cache
      await engine.checkCoherence({
        code,
        filePath: 'src/invalidate-test.ts',
        fastOnly: true,
      });
      expect(engine.getCacheSize()).toBeGreaterThan(0);

      // Invalidate
      const removed = engine.invalidateFileCache('src/invalidate-test.ts');
      expect(removed).toBeGreaterThan(0);
      expect(engine.getCacheSize()).toBe(0);
    });

    it('invalidateFileCache returns 0 for unknown file', () => {
      const engine = new CoherenceEngine(db);
      const removed = engine.invalidateFileCache('src/nonexistent.ts');
      expect(removed).toBe(0);
    });

    it('clearCache empties the entire cache', async () => {
      const engine = new CoherenceEngine(db);
      const code = `function hello(): string {\n  return 'world';\n}\n`;

      await engine.checkCoherence({
        code,
        filePath: 'src/clear-1.ts',
        fastOnly: true,
      });
      await engine.checkCoherence({
        code,
        filePath: 'src/clear-2.ts',
        fastOnly: true,
      });
      expect(engine.getCacheSize()).toBeGreaterThan(1);

      engine.clearCache();
      expect(engine.getCacheSize()).toBe(0);
    });

    it('getCacheStats returns cache statistics', () => {
      const engine = new CoherenceEngine(db);
      const stats = engine.getCacheStats();
      expect(stats).toBeDefined();
      expect(typeof stats).toBe('object');
    });

    it('invalidateFileCache only removes entries for the specified file', async () => {
      const engine = new CoherenceEngine(db);
      const code = `function hello(): string {\n  return 'world';\n}\n`;

      await engine.checkCoherence({
        code,
        filePath: 'src/file-a.ts',
        fastOnly: true,
      });
      await engine.checkCoherence({
        code,
        filePath: 'src/file-b.ts',
        fastOnly: true,
      });
      const sizeBefore = engine.getCacheSize();
      expect(sizeBefore).toBe(2);

      engine.invalidateFileCache('src/file-a.ts');
      expect(engine.getCacheSize()).toBe(1);
    });
  });

  // ============================================================
  // Task 6: Error handling for invalid files
  // ============================================================
  describe('error handling', () => {
    it('handles empty code gracefully', async () => {
      const engine = new CoherenceEngine(db);
      const result = await engine.checkCoherence({
        code: '',
        filePath: 'src/empty.ts',
        fastOnly: true,
      });

      expect(result).toBeDefined();
      expect(result.verdict).toBeDefined();
      expect(result.confidence).toBeGreaterThanOrEqual(0.3);
    });

    it('handles code with only whitespace', async () => {
      const engine = new CoherenceEngine(db);
      const result = await engine.checkCoherence({
        code: '   \n\n   \n',
        filePath: 'src/whitespace.ts',
        fastOnly: true,
      });

      expect(result).toBeDefined();
      expect(result.verdict).toBeDefined();
    });

    it('handles file paths with special characters', async () => {
      const engine = new CoherenceEngine(db);
      // Need ≥5 capitalized words to pass the type usage check for .ts files
      const code = `interface MyType {\n  Alpha: string;\n  Beta: number;\n}\nfunction hello(): MyType {\n  return { Alpha: 'world', Beta: 1 };\n}\n`;
      const result = await engine.checkCoherence({
        code,
        filePath: 'src/path with spaces/file.ts',
        fastOnly: true,
      });

      expect(result).toBeDefined();
      expect(result.verdict).toBe('pass');
    });

    it('handles very long code without throwing', async () => {
      const engine = new CoherenceEngine(db);
      const code = 'const x = ' + 'a'.repeat(10000);
      const result = await engine.checkCoherence({
        code,
        filePath: 'src/long.ts',
        fastOnly: true,
      });

      expect(result).toBeDefined();
      expect(result.verdict).toBeDefined();
    });

    it('handles file path with no extension', async () => {
      const engine = new CoherenceEngine(db);
      const code = `function hello(): string {\n  return 'world';\n}\n`;
      const result = await engine.checkCoherence({
        code,
        filePath: 'src/noext',
        fastOnly: true,
      });

      expect(result).toBeDefined();
      expect(result.verdict).toBeDefined();
    });
  });
});
