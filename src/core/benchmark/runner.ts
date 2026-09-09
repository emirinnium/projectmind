import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { assertProjectPath } from '../security/path-security.js';
import {
  aggregateRankingScores,
  scoreRankingObservation,
  type AggregateRankingScore,
  type RankingScore,
} from './scoring.js';
import type { BenchmarkCase, BenchmarkManifest } from './manifest.js';
import { logger } from '../../utils/logger.js';

export interface BenchmarkRunResult {
  manifest: { name: string; version: number; access: string; seed: number; inputHash: string };
  scores: RankingScore[];
  aggregate: AggregateRankingScore;
  filesIndexed: number;
  durationMs: number;
  limitations: string[];
}

interface Candidate {
  path: string;
  content: string;
}

export interface BenchmarkSearchResult {
  query: string;
  results: Array<{ path: string; score: number; sourceBytes: number; estimatedTokens: number }>;
  filesIndexed: number;
  durationMs: number;
  limitations: string[];
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .filter((token) => token.length > 1);
}

function collectSourceFiles(root: string): Candidate[] {
  const candidates: Candidate[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === 'dist' ||
        entry.name === 'coverage'
      )
        continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (
        !['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(entry.name).toLowerCase())
      )
        continue;
      try {
        const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
        const safePath = assertProjectPath(relativePath, root, {
          mustExist: true,
          rejectIgnored: true,
        });
        const content = readFileSync(safePath, 'utf8');
        candidates.push({ path: relativePath, content });
      } catch (error) {
        // A benchmark must report available candidates only; unreadable files are not fabricated.
        logger.debug('Benchmark skipped unreadable source file.', {
          path: absolutePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  visit(root);
  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}

function rankCase(testCase: BenchmarkCase, candidates: readonly Candidate[]): string[] {
  const queryTokens = tokenize([testCase.query, ...testCase.aliases].join(' '));
  const scored = candidates.map((candidate) => {
    const haystackTokens = tokenize(`${candidate.path} ${candidate.content}`);
    const counts = new Map<string, number>();
    for (const token of haystackTokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    const score = queryTokens.reduce((sum, token) => sum + (counts.get(token) ?? 0), 0);
    const exactPathBoost = queryTokens.some((token) => candidate.path.toLowerCase().includes(token))
      ? 4
      : 0;
    return { path: candidate.path, score: score + exactPathBoost };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .filter((candidate) => candidate.score > 0)
    .slice(0, 10)
    .map((candidate) => candidate.path);
}

/** Run the same deterministic lexical baseline used by benchmark manifests. */
export function runLexicalSearch(
  query: string,
  projectRoot: string,
  limit = 10,
): BenchmarkSearchResult {
  const started = Date.now();
  const candidates = collectSourceFiles(resolve(projectRoot));
  const boundedLimit = Math.min(50, Math.max(1, Math.floor(limit)));
  const queryTokens = tokenize(query);
  const scored = candidates
    .map((candidate) => {
      const haystackTokens = tokenize(`${candidate.path} ${candidate.content}`);
      const counts = new Map<string, number>();
      for (const token of haystackTokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      const score = queryTokens.reduce((sum, token) => sum + (counts.get(token) ?? 0), 0);
      const pathBoost = queryTokens.some((token) => candidate.path.toLowerCase().includes(token))
        ? 4
        : 0;
      return { candidate, score: score + pathBoost };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.candidate.path.localeCompare(right.candidate.path),
    )
    .filter((item) => item.score > 0)
    .slice(0, boundedLimit);
  return {
    query,
    results: scored.map(({ candidate, score }) => ({
      path: candidate.path,
      score,
      sourceBytes: Buffer.byteLength(candidate.content, 'utf8'),
      estimatedTokens: Math.max(1, Math.ceil(candidate.content.length / 4)),
    })),
    filesIndexed: candidates.length,
    durationMs: Date.now() - started,
    limitations: [
      'This command is the deterministic lexical baseline; it does not claim vector or graph relevance.',
      'Use semantic_search or search_intent for provider-backed semantic evidence.',
    ],
  };
}

/** Run the offline deterministic benchmark against the current JS/TS tree. */
export function runBenchmark(manifest: BenchmarkManifest, projectRoot: string): BenchmarkRunResult {
  const started = Date.now();
  const root = resolve(projectRoot);
  const candidates = collectSourceFiles(root);
  const limitations = new Set<string>();
  const observations = manifest.cases.map((testCase) => {
    if (testCase.kind !== 'search') {
      limitations.add(
        `Case ${testCase.id} uses the ${testCase.kind} evaluator, which is not implemented by the offline lexical runner.`,
      );
      return {
        id: testCase.id,
        expected: testCase.expectedPaths.map((path) => path.replace(/\\/g, '/')),
        actual: [],
        unknown: true,
      };
    }
    return {
      id: testCase.id,
      expected: testCase.expectedPaths.map((path) => path.replace(/\\/g, '/')),
      actual: rankCase(testCase, candidates),
      unknown: testCase.unknown,
    };
  });
  const scores = observations.map(scoreRankingObservation);
  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        manifest,
        seed: manifest.seed,
        files: candidates.map((candidate) => ({
          path: candidate.path,
          hash: createHash('sha256').update(candidate.content).digest('hex'),
        })),
      }),
    )
    .digest('hex');
  return {
    manifest: {
      name: manifest.name,
      version: manifest.version,
      access: manifest.access,
      seed: manifest.seed,
      inputHash,
    },
    scores,
    aggregate: aggregateRankingScores(scores),
    filesIndexed: candidates.length,
    durationMs: Date.now() - started,
    limitations: [...limitations],
  };
}

export function renderBenchmarkMarkdown(result: BenchmarkRunResult): string {
  const { aggregate } = result;
  const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
  return [
    `# ProjectMind Benchmark — ${result.manifest.name}`,
    '',
    `- Input hash: \`${result.manifest.inputHash}\``,
    `- Deterministic seed: ${result.manifest.seed}`,
    `- Files indexed: ${result.filesIndexed}`,
    `- Duration: ${result.durationMs} ms`,
    `- Evaluated cases: ${aggregate.evaluatedCases}/${aggregate.cases}`,
    ...(result.limitations.length > 0
      ? ['', '## Limitations', '', ...result.limitations.map((item) => `- ${item}`)]
      : []),
    '',
    '| Metric | Score |',
    '| --- | ---: |',
    `| Precision@k | ${percent(aggregate.precisionAtK)} |`,
    `| Recall@k | ${percent(aggregate.recallAtK)} |`,
    `| F1 | ${percent(aggregate.f1)} |`,
    `| MRR | ${percent(aggregate.mrr)} |`,
    `| nDCG | ${percent(aggregate.ndcg)} |`,
    '',
    '## Cases',
    '',
    '| Case | Evaluated | Precision | Recall | F1 | MRR | nDCG |',
    '| --- | :---: | ---: | ---: | ---: | ---: | ---: |',
    ...result.scores.map(
      (score) =>
        `| ${score.id} | ${score.evaluated ? 'yes' : 'unknown'} | ${(score.precisionAtK * 100).toFixed(1)}% | ${(score.recallAtK * 100).toFixed(1)}% | ${(score.f1 * 100).toFixed(1)}% | ${(score.reciprocalRank * 100).toFixed(1)}% | ${(score.ndcg * 100).toFixed(1)}% |`,
    ),
  ].join('\n');
}

const BenchmarkRunResultSchema = z
  .object({
    manifest: z
      .object({
        name: z.string().min(1),
        version: z.number().int(),
        access: z.string().min(1),
        seed: z.number().int().min(0),
        inputHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    scores: z.array(
      z
        .object({
          id: z.string().min(1),
          precisionAtK: z.number().finite().min(0).max(1),
          recallAtK: z.number().finite().min(0).max(1),
          f1: z.number().finite().min(0).max(1),
          reciprocalRank: z.number().finite().min(0).max(1),
          ndcg: z.number().finite().min(0).max(1),
          evaluated: z.boolean(),
        })
        .strict(),
    ),
    aggregate: z
      .object({
        cases: z.number().int().min(0),
        evaluatedCases: z.number().int().min(0),
        precisionAtK: z.number().finite().min(0).max(1),
        recallAtK: z.number().finite().min(0).max(1),
        f1: z.number().finite().min(0).max(1),
        mrr: z.number().finite().min(0).max(1),
        ndcg: z.number().finite().min(0).max(1),
      })
      .strict(),
    filesIndexed: z.number().int().min(0),
    durationMs: z.number().finite().min(0),
    limitations: z.array(z.string().min(1)),
  })
  .strict();

export function parseBenchmarkRunResult(raw: unknown): BenchmarkRunResult {
  return BenchmarkRunResultSchema.parse(raw) as BenchmarkRunResult;
}
