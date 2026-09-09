import { createHash } from 'node:crypto';

export interface CanonicalExampleCandidate {
  path: string;
  sourceHash: string;
  relevanceScore?: number;
  historyScore?: number;
  graphScore?: number;
  ownershipScore?: number;
  testScore?: number;
  coherenceScore?: number;
  freshnessScore?: number;
  bugFixRate?: number;
}

export interface CanonicalExampleSelection {
  selected?: {
    path: string;
    sourceHash: string;
    score: number;
    confidence: number;
    scoreBreakdown: Record<string, number>;
    reasons: string[];
  };
  considered: number;
  candidates: Array<{
    path: string;
    score: number;
    selected: boolean;
    reasons: string[];
  }>;
  evidence: string[];
  nextAction: string;
}

function clamp(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value!)) : fallback;
}

/** Select a reproducible, source-backed example and expose every signal. */
export function selectCanonicalExample(
  candidates: readonly CanonicalExampleCandidate[],
): CanonicalExampleSelection {
  const ranked = candidates
    .filter((candidate) => candidate.path.trim() && /^[a-f0-9]{64}$/i.test(candidate.sourceHash))
    .map((candidate) => {
      const history = clamp(candidate.historyScore, 0.5);
      const relevance = clamp(candidate.relevanceScore, 0.5);
      const graph = clamp(candidate.graphScore, 0.5);
      const ownership = clamp(candidate.ownershipScore, 0.5);
      const tests = clamp(candidate.testScore, 0.5);
      const coherence = clamp(candidate.coherenceScore, 0.5);
      const freshness = clamp(candidate.freshnessScore, 0.5);
      const bugStability = 1 - clamp(candidate.bugFixRate, 0.5);
      const score =
        relevance * 0.25 +
        history * 0.15 +
        graph * 0.1 +
        ownership * 0.1 +
        tests * 0.15 +
        coherence * 0.1 +
        freshness * 0.1 +
        bugStability * 0.05;
      const reasons: string[] = [];
      if (tests >= 0.7) reasons.push('test-oriented or test-backed path');
      if (relevance >= 0.7) reasons.push('strong query/source relevance');
      if (coherence >= 0.7) reasons.push('strong coherence signal');
      if (history >= 0.7) reasons.push('recent/stable Git history');
      if (graph >= 0.7) reasons.push('well-connected graph example');
      if (bugStability >= 0.7) reasons.push('low observed bug-fix rate');
      if (reasons.length === 0) reasons.push('no individual signal exceeded the strong threshold');
      return {
        candidate,
        score,
        scoreBreakdown: {
          relevance,
          history,
          graph,
          ownership,
          tests,
          coherence,
          freshness,
          bugStability,
        },
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score || a.candidate.path.localeCompare(b.candidate.path));

  const winner = ranked[0];
  if (!winner) {
    return {
      considered: 0,
      candidates: [],
      evidence: ['No source-backed candidate with a valid SHA-256 hash was supplied.'],
      nextAction:
        'Provide scanned JS/TS candidates with source hashes before claiming a canonical example.',
    };
  }
  const runnerUp = ranked[1]?.score ?? 0;
  const confidence = Math.min(1, Math.max(0, 0.5 + (winner.score - runnerUp) * 0.5));
  return {
    selected: {
      path: winner.candidate.path,
      sourceHash: winner.candidate.sourceHash,
      score: Number(winner.score.toFixed(4)),
      confidence: Number(confidence.toFixed(4)),
      scoreBreakdown: Object.fromEntries(
        Object.entries(winner.scoreBreakdown).map(([key, value]) => [
          key,
          Number(value.toFixed(4)),
        ]),
      ),
      reasons: winner.reasons,
    },
    considered: ranked.length,
    candidates: ranked.map((item) => ({
      path: item.candidate.path,
      score: Number(item.score.toFixed(4)),
      selected: item === winner,
      reasons: item.reasons,
    })),
    evidence: [
      'Selection uses source hash, history, graph, ownership, test, coherence, freshness and bug-fix signals.',
      'Missing signals receive a neutral prior; they never make a new file look unstable by default.',
    ],
    nextAction:
      confidence < 0.6
        ? 'Review the top candidates manually; the evidence gap is too small for an unqualified stable claim.'
        : 'Use the selected source hash to verify freshness before copying the example.',
  };
}

export function sourceHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
