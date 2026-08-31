import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CrossProjectPatternEngine,
  normalizeAbstractionLevel,
  buildPattern,
  defaultSuccessMetrics,
} from '../../../src/core/patterns/cross-project.js';
import { SCHEMA_SQL } from '../../../src/storage/schema.js';
import type { LearnedPattern } from '../../../src/core/patterns/types.js';

const FIXTURE_FACTORY = [
  'export interface WidgetFactory {',
  '  create(name: string): string;',
  '  destroy(id: number): void;',
  '}',
  'export class SimpleFactory {',
  '  build(size: number): string { return String(size); }',
  '}',
  '',
].join('\n');

describe('CrossProjectPatternEngine', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let db: DatabaseSync;
  let engine: CrossProjectPatternEngine;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pm-patterns-'));
    fixtureDir = join(tmpDir, 'fixture');
    mkdirSync(join(fixtureDir, 'src'), { recursive: true });
    writeFileSync(join(fixtureDir, 'src', 'factory.ts'), FIXTURE_FACTORY, 'utf-8');

    db = new DatabaseSync(join(tmpDir, 'patterns.db'));
    db.exec(SCHEMA_SQL);
    engine = new CrossProjectPatternEngine(db, { similarityThreshold: 0.6 });
  });

  afterAll(() => {
    engine.close();
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // (a) extractPatterns on fixture tree populates language/filePath/signature
  it('extracts patterns with variant language/filePath/signature from a fixture tree', () => {
    const patterns = engine.extractPatterns('proj-a', fixtureDir);
    expect(patterns.length).toBeGreaterThanOrEqual(2);

    const widget = patterns.find((p) => p.name === 'WidgetFactory');
    expect(widget).toBeDefined();
    expect(widget!.projectId).toBe('proj-a');
    expect(widget!.patternId).toBe(widget!.id);
    expect(widget!.originProject).toBe('proj-a');
    expect(widget!.abstractTemplate.methodSignatures.length).toBeGreaterThan(0);

    // F34 variant fields
    expect(widget!.implementationVariants).toBe(widget!.variants);
    expect(widget!.implementationVariants.length).toBe(1);
    const variant = widget!.implementationVariants[0];
    expect(variant.language).toBe('typescript');
    expect(variant.filePath.replace(/\\/g, '/')).toBe('src/factory.ts');
    expect(variant.signature).toContain('create');
    expect(Array.isArray(variant.embedding)).toBe(true);

    // F37: confidence computed, not the old hardcoded 0.88
    expect(widget!.confidence).toBeGreaterThan(0);
    expect(widget!.confidence).toBeLessThan(1);
    expect(widget!.confidence).not.toBeCloseTo(0.88);
  });

  // (f) successMetrics defaults present
  it('populates successMetrics defaults', () => {
    const patterns = engine.extractPatterns('proj-m', fixtureDir);
    for (const p of patterns) {
      expect(p.successMetrics).toEqual({ usedInProjects: 1, testCoverage: 0, bugRate: 0 });
    }
    expect(defaultSuccessMetrics()).toEqual({ usedInProjects: 1, testCoverage: 0, bugRate: 0 });
  });

  // (b) sync twice -> no duplicate rows (UNIQUE(code_hash, name) works)
  it('syncing the same pattern twice creates no duplicate rows', () => {
    const patterns = engine.extractPatterns('proj-b', fixtureDir);
    const widget = patterns.find((p) => p.name === 'WidgetFactory')!;

    const first = engine.syncPatternToProject(widget, 'proj-target');
    const second = engine.syncPatternToProject(widget, 'proj-target');
    expect(first).toBe(true);
    expect(second).toBe(false); // ignored by UNIQUE(code_hash, name)

    const row = db
      .prepare("SELECT COUNT(*) AS n FROM patterns WHERE project_id = 'proj-target'")
      .get() as { n: number };
    expect(row.n).toBe(1);
  });

  // (c) findSimilar returns stored template + computed confidence in (0,1]
  it('finds similar patterns with real template and computed confidence', () => {
    // Sync a pattern into a string (non-numeric) project id — F37: no parseInt.
    // NOTE: UNIQUE(code_hash, name) is global, so use a pattern (SimpleFactory)
    // that was not synced by the duplicate-rows test above.
    const patterns = engine.extractPatterns('proj-c', fixtureDir);
    const simple = patterns.find((p) => p.name === 'SimpleFactory')!;
    expect(engine.syncPatternToProject(simple, 'proj-target-2')).toBe(true);

    // Query from another project with the same abstract template.
    const query = engine.extractPatterns('proj-query', fixtureDir).find((p) => p.name === 'SimpleFactory')!;
    const matches = engine.findSimilarPatternsInProject(query, 'proj-target-2');

    expect(matches.length).toBeGreaterThanOrEqual(1);
    const match = matches[0];
    // Real stored template reconstructed — not empty.
    expect(match.abstractTemplate.methodSignatures.length).toBeGreaterThan(0);
    expect(match.abstractTemplate.interfaceName).toBe('SimpleFactory');
    // Confidence is the actual similarity score, in (0, 1].
    expect(match.similarity).toBeGreaterThan(0);
    expect(match.similarity).toBeLessThanOrEqual(1);
    expect(match.confidence).toBe(match.similarity);
    // Hash-fallback embedding -> marked low-confidence.
    expect(match.lowConfidence).toBe(true);
    expect(match.originProject).toBe('proj-target-2');
  });

  // (d) constructor without db throws instead of opening projectmind.db
  it('requires an explicit database', () => {
    expect(
      () => new CrossProjectPatternEngine(undefined as unknown as string)
    ).toThrow(/explicit database/i);
    expect(
      () => new CrossProjectPatternEngine(null as unknown as string)
    ).toThrow(/explicit database/i);
  });

  it('accepts a file path and creates the schema locally', () => {
    const local = new CrossProjectPatternEngine(join(tmpDir, 'local.db'));
    try {
      const patterns = local.extractPatterns('proj-local', fixtureDir);
      expect(local.syncPatternToProject(patterns[0], 'proj-local-target')).toBe(true);
    } finally {
      local.close();
    }
  });

  it('throws a clear error when the patterns table does not exist (F35)', () => {
    const bare = new DatabaseSync(':memory:'); // no schema init
    const bareEngine = new CrossProjectPatternEngine(bare);
    const patterns = engine.extractPatterns('proj-x', fixtureDir);
    expect(() => bareEngine.syncPatternToProject(patterns[0], 'any')).toThrow(/patterns table/i);
    bare.close();
  });

  // (e) abstractionLevel mapping round-trip
  it('maps legacy abstraction levels and passes spec levels through', () => {
    expect(normalizeAbstractionLevel('concrete')).toBe('idiomatic');
    expect(normalizeAbstractionLevel('template')).toBe('design');
    expect(normalizeAbstractionLevel('abstract')).toBe('architectural');
    expect(normalizeAbstractionLevel('idiomatic')).toBe('idiomatic');
    expect(normalizeAbstractionLevel('design')).toBe('design');
    expect(normalizeAbstractionLevel('architectural')).toBe('architectural');

    const base: LearnedPattern = buildPattern({
      id: 'p-legacy',
      name: 'Legacy',
      category: 'interface',
      description: '',
      codeHash: '{}',
      confidence: 0.5,
      firstSeen: '',
      lastSeen: '',
      usageCount: 1,
      embedding: null,
      projectId: 'orig',
      abstractionLevel: 'concrete', // deprecated alias accepted on write
      abstractTemplate: { interfaceName: 'Legacy', methodSignatures: [], parameters: [], returnType: '' },
      variants: [],
    });
    expect(base.abstractionLevel).toBe('idiomatic');
    expect(base.originProject).toBe('orig');
    expect(base.patternId).toBe('p-legacy');
    expect(base.implementationVariants).toEqual([]);
  });

  it('extracted patterns use the mapped design level', () => {
    const patterns = engine.extractPatterns('proj-level', fixtureDir);
    for (const p of patterns) {
      expect(['architectural', 'design', 'idiomatic']).toContain(p.abstractionLevel);
    }
    expect(patterns[0].abstractionLevel).toBe('design');
  });

  it('comparePatterns uses embedding cosine similarity', () => {
    const patterns = engine.extractPatterns('proj-cmp', fixtureDir);
    const a = patterns[0];
    const sim = engine.comparePatterns(a, { ...a, id: 'copy', patternId: 'copy' });
    expect(sim).toBeCloseTo(1);
  });

  it('buildGraph creates edges above threshold', () => {
    const patterns = engine.extractPatterns('proj-g', fixtureDir);
    const graph = engine.buildGraph(patterns, 'proj-g');
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.originProjectId).toBe('proj-g');
    for (const e of graph.edges) {
      expect(e.similarity).toBeGreaterThanOrEqual(0.6);
    }
  });
});
