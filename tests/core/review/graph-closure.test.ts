import { describe, expect, it } from 'vitest';
import { buildReviewGraphClosure } from '../../../src/core/review/graph-closure.js';

function path(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function graph() {
  const files = new Map([
    ['src/main.ts', { id: 1, relativePath: 'src/main.ts' }],
    ['src/lib.ts', { id: 2, relativePath: 'src/lib.ts' }],
    ['src/app.ts', { id: 3, relativePath: 'src/app.ts' }],
  ]);
  const imports = new Map([
    [1, [{ resolvedFile: { relativePath: 'src/lib.ts' } }]],
    [2, []],
    [3, [{ resolvedFile: { relativePath: 'src/lib.ts' } }]],
  ]);
  const dependents = new Map([
    [1, []],
    [
      2,
      [
        { id: 1, relativePath: 'src/main.ts' },
        { id: 3, relativePath: 'src/app.ts' },
      ],
    ],
    [3, []],
  ]);
  return {
    getFileByPath: (value: string) => files.get(path(value)) ?? null,
    getImportsWithDetails: (id: number) => imports.get(id) ?? [],
    getDependents: (id: number) => dependents.get(id) ?? [],
  };
}

describe('review graph closure', () => {
  it('builds a deterministic bounded import/dependent neighborhood', () => {
    const first = buildReviewGraphClosure(['.\\src\\main.ts', 'src/lib.ts'], graph());
    const second = buildReviewGraphClosure(['src/lib.ts', 'src/main.ts'], graph());

    expect(first).toEqual(second);
    expect(first.roots).toEqual(['src/lib.ts', 'src/main.ts']);
    expect(first.nodes).toEqual([
      {
        path: 'src/lib.ts',
        depth: 0,
        imports: [],
        dependents: ['src/app.ts', 'src/main.ts'],
      },
      {
        path: 'src/main.ts',
        depth: 0,
        imports: ['src/lib.ts'],
        dependents: [],
      },
      {
        path: 'src/app.ts',
        depth: 1,
        imports: ['src/lib.ts'],
        dependents: [],
      },
    ]);
    expect(first.limitations.join(' ')).toContain('only changed files');
  });

  it('reports truncation instead of silently dropping graph context', () => {
    const result = buildReviewGraphClosure(['src/lib.ts'], graph(), {
      maxDepth: 10,
      maxNodes: 1,
    });
    expect(result.nodes).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.limitations.join(' ')).toContain('stopped at 1 nodes');
  });

  it('rejects unsafe or unbounded closure options', () => {
    expect(() => buildReviewGraphClosure([], graph(), { maxDepth: -1 })).toThrow();
    expect(() => buildReviewGraphClosure([], graph(), { maxNodes: 10_001 })).toThrow();
  });
});
