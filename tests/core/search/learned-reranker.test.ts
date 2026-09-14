import { describe, expect, it } from 'vitest';
import { LearnedSearchReranker } from '../../../src/core/search/learned-reranker.js';
import { createIsolatedDatabase } from '../../test-helpers/database.js';

const positiveFeatures = {
  lexical: 1,
  vector: 0.8,
  graph: 0.7,
  history: 0.6,
  freshness: 1,
  fileType: 1,
  pathDepth: 0.4,
  canonical: 0.8,
};
const negativeFeatures = { ...positiveFeatures, lexical: 0, vector: 0.1 };

describe('LearnedSearchReranker', () => {
  it('keeps cold-start ranking deterministic and stores no query content', () => {
    const isolated = createIsolatedDatabase();
    try {
      const reranker = new LearnedSearchReranker(isolated.db, 1, { minimumObservations: 4 });
      const receipt = reranker.recordFeedback({
        query: 'private query text',
        resultPath: 'src/auth.ts',
        position: 1,
        feedback: 'selected',
        features: positiveFeatures,
      });
      expect(receipt.status.active).toBe(false);
      expect(
        reranker
          .rerank([
            { path: 'src/z.ts', baselineScore: 0.8, features: positiveFeatures },
            { path: 'src/a.ts', baselineScore: 0.8, features: negativeFeatures },
          ])
          .results.map((item) => item.path),
      ).toEqual(['src/z.ts', 'src/a.ts']);
      const row = isolated.db
        .prepare('SELECT query_hash, result_path FROM search_interactions')
        .get() as {
        query_hash: string;
        result_path: string;
      };
      expect(row.query_hash).not.toContain('private query text');
      expect(row.result_path).toBe('src/auth.ts');
    } finally {
      isolated.cleanup();
    }
  });

  it('activates only after positive and skipped evidence, then learns the feature preference', () => {
    const isolated = createIsolatedDatabase();
    try {
      const reranker = new LearnedSearchReranker(isolated.db, 1, {
        minimumObservations: 4,
        learningRate: 0.2,
      });
      for (let index = 0; index < 2; index++) {
        reranker.recordFeedback({
          query: 'same query',
          resultPath: `src/positive-${index}.ts`,
          position: 1,
          feedback: 'selected',
          features: positiveFeatures,
        });
        reranker.recordFeedback({
          query: 'same query',
          resultPath: `src/negative-${index}.ts`,
          position: 2,
          feedback: 'skipped',
          features: negativeFeatures,
        });
      }
      expect(reranker.getStatus()).toMatchObject({
        active: true,
        observations: 4,
        positiveObservations: 2,
        negativeObservations: 2,
      });
      const ranked = reranker.rerank([
        { path: 'src/positive.ts', baselineScore: 0.5, features: positiveFeatures },
        { path: 'src/negative.ts', baselineScore: 0.5, features: negativeFeatures },
      ]).results;
      expect(ranked[0]?.path).toBe('src/positive.ts');
      expect(ranked[0]?.learnedScore).toBeGreaterThan(ranked[1]?.learnedScore ?? 1);
    } finally {
      isolated.cleanup();
    }
  });

  it('rejects absolute and traversal result paths', () => {
    const isolated = createIsolatedDatabase();
    try {
      const reranker = new LearnedSearchReranker(isolated.db, 1);
      expect(() =>
        reranker.recordFeedback({
          query: 'q',
          resultPath: '../outside.ts',
          position: 1,
          feedback: 'skipped',
          features: positiveFeatures,
        }),
      ).toThrow(/project-relative/i);
    } finally {
      isolated.cleanup();
    }
  });
});
