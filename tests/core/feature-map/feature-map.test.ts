import { describe, expect, it } from 'vitest';
import type { KnowledgeGraph } from '../../../src/storage/knowledge-graph.js';
import type { FileInfo } from '../../../src/storage/kg/types.js';
import { buildFeatureMap, featureKeyForPath } from '../../../src/core/feature-map/feature-map.js';

function file(id: number, relativePath: string): FileInfo {
  return {
    id,
    path: `C:/project/${relativePath}`,
    relativePath,
    language: 'typescript',
    sizeBytes: 100,
    hash: `hash-${id}`,
    agentTouched: false,
    agentTouchedBy: null,
    agentTouchedAt: null,
    cognitiveLoad: 0.1,
    lastScanned: '2026-01-01 00:00:00',
    lastSynced: '2026-01-01 00:00:00',
    patterns: [],
  };
}

describe('feature map', () => {
  it('uses explicit path boundaries and labels candidates conservatively', () => {
    expect(featureKeyForPath('src/core/auth/token.ts')).toMatchObject({
      key: 'core:auth',
      label: 'Core auth',
      confidence: 0.94,
    });
    expect(featureKeyForPath('src/cli/commands/doctor.ts').key).toBe('cli-command:doctor');
    expect(featureKeyForPath('src/mcp/tools/graph.ts').key).toBe('mcp-tool:graph');
  });

  it('reports cross-feature imports, entry files, and tests instead of only counts', () => {
    const auth = file(1, 'src/core/auth/token.ts');
    const fs = file(2, 'src/utils/fs.ts');
    const test = file(3, 'tests/core/auth/token.test.ts');
    const imports = new Map<number, Array<{ source: string; kind: string; resolvedFile: FileInfo | null }>>([
      [1, [{ source: '../../utils/fs.js', kind: 'import', resolvedFile: fs }]],
      [2, []],
      [3, [{ source: '../../../src/core/auth/token.js', kind: 'import', resolvedFile: auth }]],
    ]);
    const kg = {
      getAllFiles: () => [auth, fs, test],
      getImportsWithDetails: (id: number) => imports.get(id) ?? [],
    } as unknown as KnowledgeGraph;

    const report = buildFeatureMap(kg);
    const authFeature = report.features.find((candidate) => candidate.key === 'core:auth');
    const utilsFeature = report.features.find((candidate) => candidate.key === 'src:utils');

    expect(report.totalSourceFiles).toBe(2);
    expect(authFeature?.files).toEqual(['src/core/auth/token.ts']);
    expect(authFeature?.entryFiles).toEqual(['src/core/auth/token.ts']);
    expect(authFeature?.testFiles).toEqual(['tests/core/auth/token.test.ts']);
    expect(authFeature?.dependencies).toEqual(['src:utils']);
    expect(utilsFeature?.dependents).toEqual(['core:auth']);
    expect(report.flows).toEqual([
      {
        from: 'core:auth',
        to: 'src:utils',
        importCount: 1,
        examples: ['src/core/auth/token.ts -> src/utils/fs.ts'],
      },
    ]);
    expect(report.limitations.some((item) => item.includes('not proof'))).toBe(true);
  });

  it('keeps the output bounded while preserving the complete feature count', () => {
    const first = file(1, 'src/core/one.ts');
    const second = file(2, 'src/core/two.ts');
    const kg = {
      getAllFiles: () => [first, second],
      getImportsWithDetails: () => [],
    } as unknown as KnowledgeGraph;

    const report = buildFeatureMap(kg, 1);
    expect(report.totalFeatures).toBe(2);
    expect(report.features).toHaveLength(1);
    expect(report.limitations.at(-1)).toContain('top 1');
  });
});
