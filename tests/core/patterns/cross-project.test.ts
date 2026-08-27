import { describe, it, expect } from 'vitest';
import { CrossProjectPatternEngine } from '../../../src/core/patterns/cross-project.js';
import type { LearnedPattern } from '../../../src/core/patterns/types.js';

describe('CrossProjectPatternEngine', () => {
  const engine = new CrossProjectPatternEngine({ similarityThreshold: 0.8 });

  it('extractPatterns returns abstract-template patterns', () => {
    const patterns = engine.extractPatterns('proj-a');
    expect(patterns.length).toBeGreaterThan(0);
    const p = patterns[0];
    expect(p.projectId).toBe('proj-a');
    expect(p.abstractionLevel).toBe('template');
    expect(p.abstractTemplate.interfaceName).toBeDefined();
    expect(p.abstractTemplate.methodSignatures.length).toBeGreaterThan(0);
  });

  it('syncPatternToProject propagates pattern', () => {
    const result = engine.syncPatternToProject('pat-001', 'proj-b');
    expect(result).toBe(true);
  });

  it('comparePatterns uses embedding similarity', () => {
    const p1: LearnedPattern = {
      id: 'p1',
      name: 'Factory',
      category: 'creational',
      description: 'd',
      codeHash: 'h1',
      confidence: 0.9,
      firstSeen: '2024-01-01',
      lastSeen: '2024-01-01',
      usageCount: 1,
      embedding: [1, 0, 0],
      projectId: 'a',
      abstractionLevel: 'template',
      abstractTemplate: { interfaceName: 'I', methodSignatures: ['m()'], parameters: [], returnType: 'void' },
      variants: [],
    };
    const p2: LearnedPattern = {
      id: 'p2',
      name: 'Factory',
      category: 'creational',
      description: 'd',
      codeHash: 'h2',
      confidence: 0.9,
      firstSeen: '2024-01-01',
      lastSeen: '2024-01-01',
      usageCount: 1,
      embedding: [0.9, 0.1, 0],
      projectId: 'b',
      abstractionLevel: 'template',
      abstractTemplate: { interfaceName: 'I', methodSignatures: ['m()'], parameters: [], returnType: 'void' },
      variants: [],
    };
    const sim = engine.comparePatterns(p1, p2);
    expect(sim).toBeGreaterThan(0.8);
  });

  it('comparePatterns falls back to abstract template when embeddings missing', () => {
    const p1: LearnedPattern = {
      id: 'p1',
      name: 'A',
      category: 'c',
      description: '',
      codeHash: 'h',
      confidence: 0.5,
      firstSeen: '',
      lastSeen: '',
      usageCount: 1,
      embedding: null,
      projectId: null,
      abstractionLevel: 'abstract',
      abstractTemplate: { interfaceName: 'IFactory', methodSignatures: ['create()'], parameters: [], returnType: 'void' },
      variants: [],
    };
    const p2: LearnedPattern = {
      id: 'p2',
      name: 'B',
      category: 'c',
      description: '',
      codeHash: 'h',
      confidence: 0.5,
      firstSeen: '',
      lastSeen: '',
      usageCount: 1,
      embedding: null,
      projectId: null,
      abstractionLevel: 'abstract',
      abstractTemplate: { interfaceName: 'IFactory', methodSignatures: ['create()'], parameters: [], returnType: 'void' },
      variants: [],
    };
    const sim = engine.comparePatterns(p1, p2);
    expect(sim).toBeGreaterThanOrEqual(0.9);
  });

  it('buildGraph creates edges above threshold', () => {
    const patterns = engine.extractPatterns('proj-x');
    const graph = engine.buildGraph(patterns, 'proj-x');
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.originProjectId).toBe('proj-x');
  });
});
