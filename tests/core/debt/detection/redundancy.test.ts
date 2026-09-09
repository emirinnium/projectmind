import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { FileInfo } from '../../../../src/storage/knowledge-graph.js';
import { RedundancyDetector } from '../../../../src/core/debt/detection/redundancy.js';

function file(id: number, relativePath: string): FileInfo {
  return {
    id,
    path: relativePath,
    relativePath,
    language: 'typescript',
    sizeBytes: 512,
    hash: `hash-${id}`,
    agentTouched: false,
    agentTouchedBy: null,
    agentTouchedAt: null,
    cognitiveLoad: 0,
    lastScanned: '',
    lastSynced: '',
    patterns: [],
  };
}

describe('RedundancyDetector', () => {
  it('does not compare embeddings with incompatible dimensions', async () => {
    const db = new DatabaseSync(':memory:', { allowExtension: true });
    const detector = new RedundancyDetector(db);
    const target = file(1, 'src/target.ts');
    const matching = [1, 0, 0, 0];
    const incompatible = [1, 0, 0];

    const results = await detector.findSimilarFiles(
      target,
      matching,
      [target, file(2, 'src/matching.ts'), file(3, 'src/incompatible.ts')],
      new Map([
        [2, matching],
        [3, incompatible],
      ]),
    );

    expect(results.map((result) => result.id)).toEqual([2]);
    db.close();
  });
});
