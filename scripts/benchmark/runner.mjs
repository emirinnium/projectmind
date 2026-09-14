import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { assertProjectPath } from '../../dist/core/security/path-security.js';
import { aggregateRankingScores, scoreRankingObservation } from './scoring.mjs';
import { logger } from '../../dist/utils/logger.js';
import { lexicalRelevance } from '../../dist/core/search/hybrid-ranking.js';
function collectSourceFiles(root) {
  const candidates = [];
  const visit = (directory) => {
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
function rankCase(testCase, candidates) {
  const scored = candidates.map((candidate) => {
    return {
      path: candidate.path,
      score: lexicalRelevance(
        [testCase.query, ...testCase.aliases].join(' '),
        candidate.path,
        candidate.content,
      ),
    };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .filter((candidate) => candidate.score > 0)
    .slice(0, 10)
    .map((candidate) => candidate.path);
}
function normalizeModulePath(value) {
  return value
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/u, '')
    .replace(/\.(?:[cm]?[jt]sx?)$/iu, '');
}
function importedFilePaths(candidate, candidatesByModule) {
  const imports = candidate.content.matchAll(
    /(?:from\s*|import\s*|require\s*\(\s*)["']([^"']+)["']/gu,
  );
  const resolved = [];
  for (const match of imports) {
    const specifier = match[1];
    if (!specifier?.startsWith('.')) continue;
    const modulePath = normalizeModulePath(join(dirname(candidate.path), specifier));
    const target = candidatesByModule.get(modulePath);
    if (target) resolved.push(target);
  }
  return [...new Set(resolved)].sort();
}
function rankStructuralCase(testCase, candidates) {
  const candidatesByModule = new Map();
  for (const candidate of candidates) {
    const module = normalizeModulePath(candidate.path);
    candidatesByModule.set(module, candidate.path);
    candidatesByModule.set(`${module}/index`, candidate.path);
  }
  const importsByFile = new Map();
  for (const candidate of candidates)
    importsByFile.set(candidate.path, importedFilePaths(candidate, candidatesByModule));
  if (testCase.kind === 'impact') {
    const targetPaths = candidates
      .filter((candidate) =>
        testCase.targetPath
          ? normalizeModulePath(testCase.targetPath) === normalizeModulePath(candidate.path)
          : testCase.expectedPaths.some(
              (expected) => normalizeModulePath(expected) === normalizeModulePath(candidate.path),
            ) || lexicalRelevance(testCase.query, candidate.path, candidate.content) > 0,
      )
      .map((candidate) => candidate.path);
    const impacted = candidates.filter((candidate) =>
      (importsByFile.get(candidate.path) ?? []).some((path) => targetPaths.includes(path)),
    );
    return impacted
      .map((candidate) => ({
        candidate,
        score: lexicalRelevance(testCase.query, candidate.path, candidate.content),
      }))
      .sort(
        (left, right) =>
          right.score - left.score || left.candidate.path.localeCompare(right.candidate.path),
      )
      .map(({ candidate }) => candidate.path);
  }
  if (testCase.kind === 'dead-code') {
    const imported = new Set([...importsByFile.values()].flat());
    return candidates
      .filter((candidate) => !imported.has(candidate.path))
      .filter(
        (candidate) =>
          !/(?:^|\/)(?:index|main|server|cli)(?:\.[cm]?[jt]sx?)?$/iu.test(candidate.path),
      )
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((candidate) => candidate.path);
  }
  // Review benchmark is intentionally file-level and deterministic. It uses
  // the same high-signal patterns as the built-in review rules, while line
  // position and model-written finding quality remain separate benchmarks.
  return candidates
    .filter((candidate) =>
      /\b(?:TODO|FIXME|HACK)\b|:\s*any\b|\beval\s*\(/iu.test(candidate.content),
    )
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((candidate) => candidate.path);
}
/** Run the same deterministic lexical baseline used by benchmark manifests. */
export function runLexicalSearch(query, projectRoot, limit = 10) {
  const started = Date.now();
  const candidates = collectSourceFiles(resolve(projectRoot));
  const boundedLimit = Math.min(50, Math.max(1, Math.floor(limit)));
  const scored = candidates
    .map((candidate) => {
      return {
        candidate,
        score: lexicalRelevance(query, candidate.path, candidate.content),
      };
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
export function runBenchmark(manifest, projectRoot) {
  const started = Date.now();
  const root = resolve(projectRoot);
  const candidates = collectSourceFiles(root);
  const limitations = new Set();
  const observations = manifest.cases.map((testCase) => {
    if (testCase.kind !== 'search') {
      const actual = rankStructuralCase(testCase, candidates);
      if (testCase.kind === 'impact')
        limitations.add(
          'Impact benchmark uses statically parsed relative imports; dynamic imports, runtime dispatch and package exports are not proven.',
        );
      if (testCase.kind === 'dead-code')
        limitations.add(
          'Dead-code benchmark reports only files without observed inbound relative imports; package entry points and runtime-loaded modules require manual labels.',
        );
      if (testCase.kind === 'review')
        limitations.add(
          'Review benchmark measures deterministic file-level rule candidates; line position and model-written review quality require the review pipeline benchmark.',
        );
      return {
        id: testCase.id,
        expected: testCase.expectedPaths.map((path) => path.replace(/\\/g, '/')),
        actual,
        unknown: testCase.unknown,
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
    observations,
    aggregate: aggregateRankingScores(scores),
    filesIndexed: candidates.length,
    durationMs: Date.now() - started,
    limitations: [...limitations],
  };
}
/**
 * Run the metadata-first corpus against pre-existing local checkouts.
 *
 * The runner never clones or fetches repositories and never trusts the
 * manifest's commit claim without checking the local checkout when
 * `verifyCommits` is enabled. This keeps public benchmark execution
 * reproducible and offline while making missing/stale checkouts explicit.
 */
export function runCorpusBenchmark(manifest, repositoryRoots, options = {}) {
  const started = Date.now();
  const verifyCommits = options.verifyCommits ?? true;
  const limitations = new Set();
  const repositoryResults = [];
  const allScores = [];
  const manifestCases = new Map();
  for (const item of manifest.cases) {
    const cases = manifestCases.get(item.repositoryId) ?? [];
    cases.push(item.case);
    manifestCases.set(item.repositoryId, cases);
  }
  for (const repository of manifest.repositories) {
    const checkoutPath = repositoryRoots[repository.id];
    const resultBase = {
      repositoryId: repository.id,
      checkoutPath: checkoutPath ?? '',
      expectedCommit: repository.commitSha,
      actualCommit: null,
      commitVerified: false,
      limitations: [],
    };
    if (!checkoutPath || !existsSync(checkoutPath) || !statSync(checkoutPath).isDirectory()) {
      const message = `Repository ${repository.id} checkout is missing; provide a local checkout at the configured repository root.`;
      resultBase.limitations.push(message);
      limitations.add(message);
      repositoryResults.push({ ...resultBase, result: null });
      continue;
    }
    let actualCommit = null;
    if (verifyCommits) {
      try {
        actualCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: checkoutPath,
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch (error) {
        logger.debug('Corpus repository commit verification failed.', {
          repositoryId: repository.id,
          checkoutPath,
          error: error instanceof Error ? error.message : String(error),
        });
        resultBase.limitations.push(
          `Repository ${repository.id} is not a readable Git checkout; expected commit verification could not run.`,
        );
        limitations.add(resultBase.limitations.at(-1));
        repositoryResults.push({ ...resultBase, result: null });
        continue;
      }
      if (actualCommit.toLowerCase() !== repository.commitSha.toLowerCase()) {
        const message = `Repository ${repository.id} checkout is at ${actualCommit}, expected immutable commit ${repository.commitSha}; benchmark skipped.`;
        resultBase.actualCommit = actualCommit;
        resultBase.limitations.push(message);
        limitations.add(message);
        repositoryResults.push({ ...resultBase, result: null });
        continue;
      }
    }
    const repositoryCases = manifestCases.get(repository.id) ?? [];
    const localManifest = {
      version: 1,
      name: `${manifest.name}/${repository.id}`,
      license: repository.license,
      access: manifest.access,
      seed: 0,
      cases: repositoryCases,
    };
    const result = runBenchmark(localManifest, checkoutPath);
    const prefixedScores = result.scores.map((score) => ({
      ...score,
      id: `${repository.id}/${score.id}`,
    }));
    allScores.push(...prefixedScores);
    const repositoryLimitations = [...result.limitations];
    repositoryResults.push({
      ...resultBase,
      actualCommit,
      commitVerified: verifyCommits,
      result: { ...result, scores: prefixedScores },
      limitations: repositoryLimitations,
    });
    for (const message of repositoryLimitations) limitations.add(`${repository.id}: ${message}`);
  }
  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        manifest,
        repositories: repositoryResults.map((item) => ({
          repositoryId: item.repositoryId,
          expectedCommit: item.expectedCommit,
          actualCommit: item.actualCommit,
          resultInputHash: item.result?.manifest.inputHash ?? null,
        })),
      }),
    )
    .digest('hex');
  const allCaseCount = manifest.cases.length;
  const unknownCases = manifest.cases.filter((item) => item.case.unknown).length;
  const independentlyVerifiedCases = manifest.cases.filter(
    (item) => item.case.labeling?.status === 'independently-verified',
  ).length;
  return {
    manifest: {
      name: manifest.name,
      version: manifest.version,
      access: manifest.access,
      repositories: manifest.repositories.length,
      cases: allCaseCount,
      independentlyVerifiedCases,
      pendingLabelCases: allCaseCount - independentlyVerifiedCases,
      inputHash,
    },
    repositories: repositoryResults,
    aggregate: aggregateRankingScores(allScores),
    evaluatedCases: allScores.filter((score) => score.evaluated).length,
    unknownCases,
    durationMs: Date.now() - started,
    limitations: [...limitations],
  };
}
/** Render a corpus report without implying that pending labels are validated. */
export function renderCorpusBenchmarkMarkdown(result) {
  const { manifest, aggregate } = result;
  const percent = (value) => `${(value * 100).toFixed(2)}%`;
  const labelStatus =
    manifest.independentlyVerifiedCases === manifest.cases
      ? 'independently verified'
      : 'not public-quality verified';
  return [
    `# ProjectMind Corpus Benchmark — ${manifest.name}`,
    '',
    `- Access: ${manifest.access}`,
    `- Input hash: \`${manifest.inputHash}\``,
    `- Repositories: ${manifest.repositories}`,
    `- Cases: ${manifest.cases}`,
    `- Evaluated cases: ${result.evaluatedCases}`,
    `- Unknown cases: ${result.unknownCases}`,
    `- Label status: ${labelStatus} (${manifest.independentlyVerifiedCases}/${manifest.cases} independently verified)`,
    `- Duration: ${result.durationMs} ms`,
    '',
    '| Metric | Score |',
    '| --- | ---: |',
    `| Precision@k | ${percent(aggregate.precisionAtK)} |`,
    `| Recall@k | ${percent(aggregate.recallAtK)} |`,
    `| F1 | ${percent(aggregate.f1)} |`,
    `| MRR | ${percent(aggregate.mrr)} |`,
    `| nDCG | ${percent(aggregate.ndcg)} |`,
    '',
    '## Repositories',
    '',
    '| Repository | Commit verified | Files | Evaluated cases | Limitations |',
    '| --- | :---: | ---: | ---: | --- |',
    ...result.repositories.map(
      (repository) =>
        `| ${repository.repositoryId} | ${repository.commitVerified ? 'yes' : 'no'} | ${repository.result?.filesIndexed ?? 0} | ${repository.result?.aggregate.evaluatedCases ?? 0} | ${[...repository.limitations, ...(repository.result?.limitations ?? [])].join('; ') || 'none'} |`,
    ),
    ...(result.limitations.length > 0
      ? ['', '## Limitations', '', ...result.limitations.map((item) => `- ${item}`)]
      : []),
  ].join('\n');
}
export function renderBenchmarkMarkdown(result) {
  const { aggregate } = result;
  const percent = (value) => `${(value * 100).toFixed(2)}%`;
  const observationsById = new Map(
    result.observations.map((observation) => [observation.id, observation]),
  );
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
    '| Case | Evaluated | Observed paths | Precision | Recall | F1 | MRR | nDCG |',
    '| --- | :---: | --- | ---: | ---: | ---: | ---: | ---: |',
    ...result.scores.map((score) => {
      const observation = observationsById.get(score.id);
      const observedPaths = observation?.actual.join(', ') || '(none)';
      return `| ${score.id} | ${score.evaluated ? 'yes' : 'unknown'} | ${observedPaths} | ${(score.precisionAtK * 100).toFixed(1)}% | ${(score.recallAtK * 100).toFixed(1)}% | ${(score.f1 * 100).toFixed(1)}% | ${(score.reciprocalRank * 100).toFixed(1)}% | ${(score.ndcg * 100).toFixed(1)}% |`;
    }),
  ].join('\n');
}
/**
 * Render benchmark observations as file-level SARIF evidence.
 *
 * This is intentionally not a review finding publisher: benchmark results
 * identify observed candidate files and aggregate scores, but do not prove a
 * line position, severity, or exploitable defect. Consumers can therefore
 * ingest the artifact in SARIF tooling without mistaking it for a normal
 * production review report.
 */
export function renderBenchmarkSarif(result) {
  const observationsById = new Map(
    result.observations.map((observation) => [observation.id, observation]),
  );
  const rules = result.scores.map((score) => ({
    id: `benchmark-${score.id.replace(/[^A-Za-z0-9_.-]/gu, '_')}`,
    shortDescription: { text: `Benchmark case ${score.id}` },
    helpUri: 'https://github.com/emirinnium/projectmind',
  }));
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'ProjectMind benchmark',
            version: String(result.manifest.version),
            informationUri: 'https://github.com/emirinnium/projectmind',
            rules,
          },
        },
        properties: {
          benchmarkName: result.manifest.name,
          inputHash: result.manifest.inputHash,
          deterministicSeed: result.manifest.seed,
          filesIndexed: result.filesIndexed,
          evaluatedCases: result.aggregate.evaluatedCases,
          totalCases: result.aggregate.cases,
        },
        results: result.scores.flatMap((score) => {
          const observation = observationsById.get(score.id);
          if (!observation || observation.actual.length === 0) return [];
          return observation.actual.map((path) => ({
            ruleId: `benchmark-${score.id.replace(/[^A-Za-z0-9_.-]/gu, '_')}`,
            level: 'note',
            message: {
              text: `Observed as a candidate for benchmark case ${score.id}; this is file-level benchmark evidence, not a verified review finding.`,
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: path.replace(/\\/gu, '/') },
                },
              },
            ],
            properties: {
              caseId: score.id,
              evaluated: score.evaluated,
              expectedPaths: observation.expected.join(', '),
              precisionAtK: score.precisionAtK,
              recallAtK: score.recallAtK,
              f1: score.f1,
              reciprocalRank: score.reciprocalRank,
              ndcg: score.ndcg,
            },
          }));
        }),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
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
    observations: z.array(
      z
        .object({
          id: z.string().min(1),
          expected: z.array(z.string()),
          actual: z.array(z.string()),
          unknown: z.boolean().optional(),
        })
        .strict(),
    ),
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
export function parseBenchmarkRunResult(raw) {
  return BenchmarkRunResultSchema.parse(raw);
}
