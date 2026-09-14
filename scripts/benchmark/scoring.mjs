import { z } from 'zod';
export const RankingObservationSchema = z
  .object({
    id: z.string().min(1).max(200),
    expected: z.array(z.string().min(1)).max(1000),
    actual: z.array(z.string().min(1)).max(1000),
    unknown: z.boolean().optional(),
  })
  .strict();
function safeAverage(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
export function scoreRankingObservation(observation) {
  const expected = new Set(observation.expected);
  // A ranking is a set of retrieved identities in canonical order. Duplicate
  // rows must not inflate hit counts or make precision exceed one when a
  // buggy adapter returns the same path more than once.
  const actual = [...new Set(observation.actual)];
  if (observation.unknown || expected.size === 0) {
    return {
      id: observation.id,
      precisionAtK: 0,
      recallAtK: 0,
      f1: 0,
      reciprocalRank: 0,
      ndcg: 0,
      evaluated: false,
    };
  }
  const hits = actual.filter((item) => expected.has(item)).length;
  const firstHit = actual.findIndex((item) => expected.has(item));
  const precisionAtK = hits / Math.max(1, actual.length);
  const recallAtK = hits / expected.size;
  const f1 =
    precisionAtK + recallAtK === 0
      ? 0
      : (2 * precisionAtK * recallAtK) / (precisionAtK + recallAtK);
  const dcg = actual.reduce(
    (sum, item, index) => sum + (expected.has(item) ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const idealLength = Math.min(expected.size, actual.length);
  const idcg = Array.from({ length: idealLength }, (_, index) => 1 / Math.log2(index + 2)).reduce(
    (sum, value) => sum + value,
    0,
  );
  return {
    id: observation.id,
    precisionAtK,
    recallAtK,
    f1,
    reciprocalRank: firstHit === -1 ? 0 : 1 / (firstHit + 1),
    ndcg: idcg === 0 ? 0 : dcg / idcg,
    evaluated: true,
  };
}
export function aggregateRankingScores(scores) {
  const evaluated = scores.filter((score) => score.evaluated);
  return {
    cases: scores.length,
    evaluatedCases: evaluated.length,
    precisionAtK: safeAverage(evaluated.map((score) => score.precisionAtK)),
    recallAtK: safeAverage(evaluated.map((score) => score.recallAtK)),
    f1: safeAverage(evaluated.map((score) => score.f1)),
    mrr: safeAverage(evaluated.map((score) => score.reciprocalRank)),
    ndcg: safeAverage(evaluated.map((score) => score.ndcg)),
  };
}
