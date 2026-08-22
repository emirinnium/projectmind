import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initDatabase, closeDatabase } from '../src/storage/database.js';
import { KnowledgeGraph } from '../src/storage/knowledge-graph.js';
import { CoherenceEngine } from '../src/core/coherence/engine.js';
import { DebtTracker } from '../src/core/debt/tracker.js';
import { ScaleManager } from '../src/core/scale/manager.js';
import { parseFile } from '../src/parser/ast-parser.js';
import { textToEmbedding, cosineSimilarity } from '../src/parser/embeddings.js';

const TEST_DB = join(process.cwd(), 'tests', `tmp-vitest-${randomUUID()}.db`);

describe('Integration Tests', () => {
  let db: ReturnType<typeof initDatabase>;
  let kg: KnowledgeGraph;
  let coherence: CoherenceEngine;
  let debt: DebtTracker;
  let scale: ScaleManager;

  beforeEach(() => {
    db = initDatabase(TEST_DB);
    kg = new KnowledgeGraph(db);
    coherence = new CoherenceEngine(db);
    debt = new DebtTracker(db, kg, coherence);
    scale = new ScaleManager(db, kg);
  });

  afterEach(() => {
    closeDatabase();
    // Cleanup test database
    for (let i = 0; i < 5; i++) {
      try {
        if (existsSync(TEST_DB)) rmSync(TEST_DB);
        if (existsSync(TEST_DB + '-shm')) rmSync(TEST_DB + '-shm');
        if (existsSync(TEST_DB + '-wal')) rmSync(TEST_DB + '-wal');
        break;
      } catch {
        // Retry on Windows file locking
      }
    }
  });

  describe('Database Initialization', () => {
    it('initializes database with schema', () => {
      expect(db).toBeDefined();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      expect(tables.some((t) => t.name === 'files')).toBe(true);
      expect(tables.some((t) => t.name === 'functions')).toBe(true);
      expect(tables.some((t) => t.name === 'classes')).toBe(true);
    });
  });

  describe('File Parsing', () => {
    it('parses TypeScript files', () => {
      const code = 'export function hello(name: string): string { return `Hello, ${name}`; }';
      const struct = parseFile('test.ts', code);
      expect(struct).not.toBeNull();
      expect(struct!.language).toBe('typescript');
      expect(struct!.functions.length).toBeGreaterThanOrEqual(1);
      expect(struct!.hash.length).toBeGreaterThan(0);
    });
  });

  describe('Knowledge Graph', () => {
    it('stores and retrieves files', async () => {
      const code = 'export function test() { return 1; }';
      const struct = parseFile('test.ts', code)!;
      const fileId = await kg.upsertFile(struct, 'test.ts');
      expect(fileId).toBeGreaterThan(0);

      const fileInfo = kg.getFileByPath('test.ts');
      expect(fileInfo).not.toBeNull();
      expect(fileInfo!.relativePath).toBe('test.ts');
    });

    it('manages agent sessions', () => {
      const sessionId = kg.startAgentSession('test-agent');
      expect(sessionId).toBeGreaterThan(0);

      kg.storeMemory(sessionId, 'test-scope', 'key1', JSON.stringify({ value: 'test' }));
      const memories = kg.getMemory('test-scope', 'key1');
      expect(memories.length).toBe(1);

      kg.endAgentSession(sessionId);
      const sessions = kg.getAgentSessions('test-agent');
      expect(sessions.length).toBeGreaterThan(0);
    });

    it('manages projects', () => {
      const project = kg.createProject('integration-test', '/test', 'Test project');
      expect(project.id).toBeGreaterThan(0);
      expect(project.name).toBe('integration-test');

      const projects = kg.listProjects();
      expect(projects.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Embeddings & Similarity', () => {
    it('generates embeddings with correct dimension', () => {
      const emb = textToEmbedding('hello world');
      expect(emb.length).toBe(768);
    });

    it('calculates similarity correctly', () => {
      const emb1 = textToEmbedding('hello world');
      const emb2 = textToEmbedding('world hello');
      const emb3 = textToEmbedding('completely different');

      const sim1 = cosineSimilarity(emb1, emb2);
      const sim2 = cosineSimilarity(emb1, emb3);

      expect(sim1).toBeGreaterThan(0.5);
      expect(sim2).toBeLessThan(sim1);
    });
  });

  describe('Coherence Engine', () => {
    it('checks coherence in fast mode', async () => {
      const result = await coherence.checkCoherence({
        code: 'function test() { return 1; }',
        filePath: 'test.ts',
        fastOnly: true,
      });
      expect(result.verdict).toBeDefined();
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.reasoningTrace.length).toBeGreaterThan(0);
    });

    it('caches coherence results', async () => {
      const input = {
        code: 'function cached() { return 1; }',
        filePath: 'cached.ts',
        fastOnly: true,
      };
      const result1 = await coherence.checkCoherence(input);
      const result2 = await coherence.checkCoherence(input);
      expect(result1.verdict).toBe(result2.verdict);
    });
  });

  describe('Debt Tracker', () => {
    it('computes genome', async () => {
      // First add some files to analyze
      const code = 'export function test() { return 1; }';
      const struct = parseFile('test.ts', code)!;
      await kg.upsertFile(struct, 'test.ts');

      const genome = await Promise.race([
        debt.computeGenome(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 30_000)
        ),
      ]);
      expect(genome.coherenceScore).toBeGreaterThanOrEqual(0);
      expect(genome.coherenceScore).toBeLessThanOrEqual(1);
    }, 35_000);

    it('returns debt report', () => {
      const report = debt.getReport();
      expect(report.totalItems).toBeGreaterThanOrEqual(0);
      expect(report.bySeverity.high).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Scale Manager', () => {
    it('returns scale report', () => {
      const report = scale.getScaleReport();
      expect(report).toBeDefined();
      expect(report.totalFiles).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Data-Flow Analysis', () => {
    it('records and retrieves data flows', () => {
      const flow = kg.recordDataFlow({
        fromResourceQualifiedName: 'fs.readFile("./input.txt")',
        fromResourceKind: 'FILE',
        fromResourceIdentity: './input.txt',
        toResourceQualifiedName: 'processInput',
        toResourceKind: 'ENV',
        toResourceIdentity: 'eval',
        kind: 'arg',
        via: 'processInput',
        sourceFunctionName: 'loadData',
        targetFunctionName: 'sendData',
      });
      expect(flow.id).toBeGreaterThan(0);

      const flows = kg.getDataFlows();
      expect(flows.length).toBeGreaterThanOrEqual(1);

      const cleared = kg.clearDataFlows();
      expect(cleared).toBeGreaterThanOrEqual(1);
    });
  });
});
