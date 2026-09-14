import { describe, expect, it } from 'vitest';
import {
  comparablePath,
  createLabelPacket,
  mergeLabelSubmissions,
  verifyLabelSubmissions,
} from '../../scripts/benchmark/label-kit.mjs';
import { parseBenchmarkCorpusManifest } from '../../scripts/benchmark/manifest.mjs';

const manifest = parseBenchmarkCorpusManifest({
  version: 1,
  name: 'label-kit-fixture',
  access: 'fixture',
  repositories: [
    {
      id: 'sample-repo',
      url: 'https://github.com/example/sample-repo.git',
      commitSha: 'a'.repeat(40),
      license: 'MIT',
      languages: ['typescript'],
    },
  ],
  cases: [
    {
      repositoryId: 'sample-repo',
      case: {
        id: 'entry',
        query: 'entry point',
        expectedPaths: ['src/index.ts'],
        kind: 'search',
      },
    },
    {
      repositoryId: 'sample-repo',
      case: {
        id: 'dynamic',
        query: 'runtime route',
        expectedPaths: [],
        unknown: true,
        kind: 'search',
      },
    },
  ],
});

const manifestHash = 'b'.repeat(64);

function submission(reviewerId: string, packet: ReturnType<typeof createLabelPacket>) {
  return {
    version: 1 as const,
    manifest: packet.manifest,
    reviewerId,
    labels: packet.cases.map((item: (typeof packet.cases)[number]) => ({
      caseKey: item.caseKey,
      expectedPaths: item.id === 'entry' ? ['src/index.ts'] : [],
      unknown: item.id === 'dynamic',
      method: item.id === 'dynamic' ? ('unknown' as const) : ('source-inspection' as const),
      evidence: [`Inspected ${item.repositoryId}/${item.id}.`],
    })),
  };
}

describe('benchmark independent label kit', () => {
  it('creates source-redacted packets tied to the exact manifest hash', () => {
    const packet = createLabelPacket(manifest, manifestHash, 'reviewer-a');
    expect(packet.manifest.sha256).toBe(manifestHash);
    expect(packet.cases).toHaveLength(2);
    expect(packet.cases[0]).not.toHaveProperty('expectedPaths');
    expect(packet.cases[0].caseKey).toHaveLength(64);
  });

  it('compares output paths with Windows case rules and portable separators', () => {
    expect(comparablePath('a\\b\\manifest.json')).toContain('/');
    if (process.platform === 'win32') {
      expect(comparablePath('C:\\Repo\\Manifest.json')).toBe(
        comparablePath('c:/repo/manifest.json'),
      );
    }
  });

  it('accepts unanimous distinct labels and promotes only the merged result', () => {
    const packet = createLabelPacket(manifest, manifestHash, 'reviewer-a');
    const first = submission('reviewer-a', packet);
    const second = submission('reviewer-b', {
      ...packet,
      reviewerId: 'reviewer-b',
    });
    expect(verifyLabelSubmissions(manifest, manifestHash, [first, second])).toMatchObject({
      passed: true,
      caseCount: 2,
      reviewers: ['reviewer-a', 'reviewer-b'],
    });
    const merged = mergeLabelSubmissions(manifest, manifestHash, [first, second]);
    expect(merged.cases[0].case.labeling).toMatchObject({
      status: 'independently-verified',
      reviewers: ['reviewer-a', 'reviewer-b'],
    });
    expect(merged.cases[1].case.unknown).toBe(true);
  });

  it('fails closed for disagreement, duplicate reviewers, and unsafe paths', () => {
    const packet = createLabelPacket(manifest, manifestHash, 'reviewer-a');
    const first = submission('reviewer-a', packet);
    const disagreement = structuredClone(first);
    disagreement.reviewerId = 'reviewer-b';
    disagreement.labels[0].expectedPaths = ['src/other.ts'];
    expect(verifyLabelSubmissions(manifest, manifestHash, [first, disagreement])).toMatchObject({
      passed: false,
      disagreements: [packet.cases[0].caseKey],
    });
    expect(() => verifyLabelSubmissions(manifest, manifestHash, [first, first])).toThrow(
      'distinct reviewer',
    );
    const unsafe = structuredClone(first);
    unsafe.reviewerId = 'reviewer-c';
    unsafe.labels[0].expectedPaths = ['../outside.ts'];
    expect(() => verifyLabelSubmissions(manifest, manifestHash, [first, unsafe])).toThrow(
      'unsafe repository-relative path',
    );
  });
});
