import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KnowledgeGraph } from '../../../src/storage/knowledge-graph.js';
import { stableHash } from '../../../src/utils/hash.js';
import {
  buildEvidencePacket,
  insufficientEvidencePacket,
  verifyFileFreshness,
  verifyProjectFreshness,
  type FileFreshness,
} from '../../../src/core/proof/evidence.js';

const temporaryDirectories: string[] = [];

function fakeGraph(files: Array<{ path: string; relativePath: string; hash: string; lastScanned: string }>) {
  return {
    getFileByPath: (path: string) =>
      files.find((file) => file.path === path || file.relativePath === path) ?? null,
    getAllFiles: () => files,
  } as unknown as KnowledgeGraph;
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'projectmind-proof-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const path = temporaryDirectories.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe('evidence and freshness verification', () => {
  it('marks a source fresh when its hash matches the graph', async () => {
    const root = await createProject();
    const relativePath = 'src/example.ts';
    const absolutePath = join(root, relativePath);
    await writeFile(absolutePath, 'export const answer = 42;\n', 'utf8').catch(async () => {
      await (await import('node:fs/promises')).mkdir(join(root, 'src'), { recursive: true });
      await writeFile(absolutePath, 'export const answer = 42;\n', 'utf8');
    });
    const content = 'export const answer = 42;\n';
    const graph = fakeGraph([{
      path: absolutePath,
      relativePath,
      hash: stableHash(content),
      lastScanned: '2026-09-08 12:00:00',
    }]);

    const result = await verifyFileFreshness(graph, root, relativePath);
    expect(result.status).toBe('fresh');
    expect(result.sourceHash).toBe(result.indexedHash);
    expect(result.lineCount).toBe(2);
  });

  it('distinguishes stale, unindexed, and missing files', async () => {
    const root = await createProject();
    const existing = join(root, 'existing.ts');
    const unindexed = join(root, 'unindexed.ts');
    await writeFile(existing, 'export const value = 1;\n', 'utf8');
    await writeFile(unindexed, 'export const value = 2;\n', 'utf8');
    const graph = fakeGraph([{
      path: existing,
      relativePath: 'existing.ts',
      hash: stableHash('different'),
      lastScanned: '2026-09-08 12:00:00',
    }]);

    const stale = await verifyFileFreshness(graph, root, 'existing.ts');
    const freshButUnindexed = await verifyFileFreshness(graph, root, 'unindexed.ts');
    const missing = await verifyFileFreshness(graph, root, 'missing.ts');
    expect(stale.status).toBe('stale');
    expect(freshButUnindexed.status).toBe('unindexed');
    expect(missing.status).toBe('missing');
  });

  it('returns a partial project summary instead of hiding incomplete coverage', async () => {
    const root = await createProject();
    const file = join(root, 'one.ts');
    await writeFile(file, 'export const one = 1;\n', 'utf8');
    const graph = fakeGraph([{
      path: file,
      relativePath: 'one.ts',
      hash: stableHash('export const one = 1;\n'),
      lastScanned: '2026-09-08 12:00:00',
    }]);

    const summary = await verifyProjectFreshness(graph, root, ['one.ts', 'missing.ts']);
    expect(summary.status).toBe('partial');
    expect(summary.freshFiles).toBe(1);
    expect(summary.missingFiles).toBe(1);
    expect(summary.details.map((detail: FileFreshness) => detail.status)).toEqual([
      'fresh',
      'missing',
    ]);
    const packet = buildEvidencePacket(summary);
    expect(packet.verification.graphFresh).toBe(false);
    expect(packet.claimStatus).toBe('partial');
    expect(packet.verification.limitations.length).toBeGreaterThan(0);
  });

  it('reports an unknown result instead of reading outside the project root', async () => {
    const root = await createProject();
    const graph = fakeGraph([]);
    const summary = await verifyProjectFreshness(graph, root, ['../outside.ts']);
    expect(summary.status).toBe('conflict');
    expect(summary.unknownFiles).toBe(1);
    expect(summary.details[0]?.error).toContain('escapes the project root');
  });

  it('refuses to claim proof without source evidence', () => {
    const packet = insufficientEvidencePacket('No file references were provided.');
    expect(packet.claimStatus).toBe('insufficient-evidence');
    expect(packet.confidence).toBe(0);
    expect(packet.evidence).toEqual([]);
    expect(packet.verification.sourceVerified).toBe(false);
  });
});
