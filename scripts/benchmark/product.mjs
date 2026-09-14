import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { IntentEngine } from '../../dist/core/search/intent-engine.js';
import { ProjectScanner } from '../../dist/core/scale/reporting/scanner.js';
import { KnowledgeGraph } from '../../dist/storage/kg/graph.js';
import { initEmbeddingProvider } from '../../dist/parser/embeddings-v2.js';
import { collectReviewFindings } from '../../dist/cli/commands/pr-preview-engine.js';
import { DEFAULT_REVIEW_POLICY } from '../../dist/core/review/policy.js';
import { planReviewBundles } from '../../dist/core/review/bundle.js';
import {
  reflectFindings,
  validateFindingPositions,
  verifiedFindings,
} from '../../dist/core/review/finding-validation.js';
import { parseBenchmarkCorpusManifest } from './manifest.mjs';
import { aggregateRankingScores, scoreRankingObservation } from './scoring.mjs';

const DEFAULT_CASE_TIMEOUT_MS = 30_000;
const MAX_SEARCH_LIMIT = 50;

function normalizeRelativePath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//u, '');
}

function isRelativeInsideProject(value) {
  return value !== '..' && !value.startsWith('../') && !/^[A-Za-z]:\//u.test(value);
}

function getRepositoryCommit(checkoutPath) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: checkoutPath,
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

async function withTimeout(task, timeoutMs, label) {
  const boundedTimeout = Math.max(1_000, Math.min(300_000, Math.floor(timeoutMs)));
  let timer;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${boundedTimeout}ms.`)),
          boundedTimeout,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeSearchResults(results, projectRoot, limitations) {
  const normalized = [];
  for (const result of results) {
    const relativePath = normalizeRelativePath(relative(projectRoot, result.filePath));
    if (!isRelativeInsideProject(relativePath)) {
      limitations.push(`Search result escaped the checkout boundary: ${result.filePath}`);
      continue;
    }
    if (!normalized.includes(relativePath)) normalized.push(relativePath);
  }
  return normalized;
}

function createProductCaseScore(testCase, actual) {
  return scoreRankingObservation({
    id: testCase.id,
    expected: testCase.expectedPaths.map(normalizeRelativePath),
    actual,
    unknown: testCase.unknown,
  });
}

function normalizeFileInfoResults(files, projectRoot, limitations) {
  return normalizeSearchResults(
    files.map((file) => ({ filePath: file.path ?? file.relativePath })),
    projectRoot,
    limitations,
  );
}

function productEntryPoint(relativePath) {
  return /(?:^|\/)(?:index|main|server|cli)(?:\.[cm]?[jt]sx?)?$/iu.test(relativePath);
}

async function evaluateProductCase(testCase, graph, engine, projectRoot, limit) {
  if (testCase.kind === 'search') {
    const results = await engine.search(
      {
        naturalLanguage: testCase.query,
        context: testCase.aliases.join(' '),
      },
      graph,
      limit,
    );
    return { actual: normalizeSearchResults(results, projectRoot, []), measurable: true };
  }

  if (testCase.kind === 'impact') {
    if (!testCase.targetPath) {
      return { actual: [], measurable: false, limitation: 'impact case requires targetPath.' };
    }
    const target = graph.getFileByPath(testCase.targetPath);
    if (!target) {
      return {
        actual: [],
        measurable: false,
        limitation: `impact target ${testCase.targetPath} was not found after scanning.`,
      };
    }
    return {
      actual: normalizeFileInfoResults(graph.getDependents(target.id), projectRoot, []),
      measurable: true,
    };
  }

  if (testCase.kind === 'dead-code') {
    const files = graph.getAllFiles();
    const actual = files
      .filter((file) => !productEntryPoint(file.relativePath))
      .filter((file) => graph.getDependents(file.id).length === 0)
      .map((file) => ({ filePath: file.path }))
      .sort((left, right) => left.filePath.localeCompare(right.filePath));
    return { actual: normalizeSearchResults(actual, projectRoot, []), measurable: true };
  }

  if (testCase.kind === 'review') {
    if (!testCase.changedPaths || testCase.changedPaths.length === 0) {
      return { actual: [], measurable: false, limitation: 'review case requires changedPaths.' };
    }
    const plan = planReviewBundles(testCase.changedPaths, projectRoot, DEFAULT_REVIEW_POLICY);
    const findings = collectReviewFindings(
      testCase.changedPaths,
      projectRoot,
      DEFAULT_REVIEW_POLICY,
    );
    const reflected = reflectFindings(
      validateFindingPositions(findings, plan, projectRoot),
      DEFAULT_REVIEW_POLICY,
      projectRoot,
    );
    return {
      actual: [
        ...new Set(
          verifiedFindings(reflected).map((finding) => normalizeRelativePath(finding.file)),
        ),
      ].sort(),
      measurable: true,
      limitation:
        plan.excluded.length > 0
          ? `review excluded ${plan.excluded.length} changed file(s) by policy.`
          : undefined,
    };
  }

  return {
    actual: [],
    measurable: false,
    limitation: `unsupported product case kind: ${testCase.kind}.`,
  };
}

/**
 * Run the real local ProjectMind search path against pre-existing checkouts.
 *
 * This is an internal maintainer evaluator, not a public `pm benchmark`
 * command. Each repository receives a fresh in-memory database and project
 * namespace so results cannot bleed between checkouts. The evaluator only
 * scores product cases whose required contract fields are present. Cases
 * without a safe target/changed-file contract remain explicitly unmeasured.
 */
export async function runProductCorpusBenchmark(manifest, repositoryRoots, options = {}) {
  const validatedManifest = parseBenchmarkCorpusManifest(manifest);
  const started = Date.now();
  const verifyCommits = options.verifyCommits ?? true;
  const caseTimeoutMs = options.caseTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;
  const requestedProvider = options.provider ?? 'simple';
  const providerOptions = options.providerOptions ?? {};
  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(options.limit ?? 10)));
  const limitations = new Set();
  const allScores = [];
  const repositoryResults = [];

  for (const repository of validatedManifest.repositories) {
    const checkoutPath = repositoryRoots[repository.id]
      ? resolve(repositoryRoots[repository.id])
      : undefined;
    const repositoryLimitations = [];
    const base = {
      repositoryId: repository.id,
      checkoutPath: checkoutPath ?? '',
      expectedCommit: repository.commitSha,
      actualCommit: null,
      commitVerified: false,
      provider: null,
      scan: null,
      scores: [],
      limitations: repositoryLimitations,
    };

    if (!checkoutPath || !existsSync(checkoutPath) || !statSync(checkoutPath).isDirectory()) {
      const message = `Repository ${repository.id} checkout is missing; product evaluation skipped.`;
      repositoryLimitations.push(message);
      limitations.add(message);
      repositoryResults.push(base);
      continue;
    }

    if (verifyCommits) {
      const actualCommit = getRepositoryCommit(checkoutPath);
      base.actualCommit = actualCommit;
      if (!actualCommit || actualCommit.toLowerCase() !== repository.commitSha.toLowerCase()) {
        const message = actualCommit
          ? `Repository ${repository.id} checkout is at ${actualCommit}, expected immutable commit ${repository.commitSha}; product evaluation skipped.`
          : `Repository ${repository.id} is not a readable Git checkout; product evaluation skipped.`;
        repositoryLimitations.push(message);
        limitations.add(message);
        repositoryResults.push(base);
        continue;
      }
      base.commitVerified = true;
    }

    const database = new DatabaseSync(':memory:');
    try {
      const graph = new KnowledgeGraph(database);
      const project = graph.createProject(`benchmark-${repository.id}`, checkoutPath);
      const switched = graph.switchProject(project.id);
      if (!switched.success)
        throw new Error(switched.error ?? 'Project namespace could not be selected.');

      const provider = await initEmbeddingProvider({
        ...providerOptions,
        provider: requestedProvider,
      });
      base.provider = {
        requested: provider.requestedProvider,
        active: provider.provider,
        fellBack: provider.fellBack,
        limitations: provider.limitations,
      };
      for (const message of provider.limitations) {
        repositoryLimitations.push(message);
        limitations.add(`${repository.id}: ${message}`);
      }

      const scanner = new ProjectScanner(database, graph);
      const scan = await scanner.scanProjectWithProfile(checkoutPath, true);
      base.scan = {
        totalFiles: scan.totalFiles,
        scannedFiles: scan.scannedFiles,
        errorFiles: scan.errorFiles,
        durationMs: scan.durationMs,
        filesPerSecond: scan.filesPerSecond,
      };
      if (scan.errorFiles > 0) {
        const message = `Repository ${repository.id} scan returned ${scan.errorFiles} error(s); product scores remain available but are qualified.`;
        repositoryLimitations.push(message);
        limitations.add(message);
      }

      const engine = new IntentEngine({ db: database, projectRoot: checkoutPath });
      const repositoryCases = validatedManifest.cases.filter(
        (item) => item.repositoryId === repository.id,
      );
      for (const corpusCase of repositoryCases) {
        const testCase = corpusCase.case;
        const caseStarted = Date.now();
        try {
          const evaluation = await withTimeout(
            evaluateProductCase(testCase, graph, engine, checkoutPath, limit),
            caseTimeoutMs,
            `${repository.id}/${testCase.id}`,
          );
          if (evaluation.limitation) {
            const message = `${repository.id}/${testCase.id}: ${evaluation.limitation}`;
            repositoryLimitations.push(message);
            limitations.add(message);
          }
          const actual = normalizeRelativePathList(evaluation.actual);
          const score = createProductCaseScore(
            evaluation.measurable ? testCase : { ...testCase, unknown: true },
            actual,
          );
          base.scores.push({
            ...score,
            latencyMs: Date.now() - caseStarted,
            actual,
          });
          allScores.push({ ...score, id: `${repository.id}/${score.id}`, actual });
        } catch (error) {
          const message = `${repository.id}/${testCase.id} could not be evaluated: ${error instanceof Error ? error.message : String(error)}`;
          repositoryLimitations.push(message);
          limitations.add(message);
          const score = createProductCaseScore({ ...testCase, unknown: true }, []);
          base.scores.push({ ...score, latencyMs: Date.now() - caseStarted, actual: [] });
          allScores.push({ ...score, id: `${repository.id}/${score.id}`, actual: [] });
        }
      }
    } catch (error) {
      const message = `Repository ${repository.id} product setup failed: ${error instanceof Error ? error.message : String(error)}`;
      repositoryLimitations.push(message);
      limitations.add(message);
    } finally {
      database.close();
    }
    repositoryResults.push(base);
  }

  const independentlyVerifiedCases = validatedManifest.cases.filter(
    (item) => item.case.labeling?.status === 'independently-verified',
  ).length;
  const evaluatedCases = allScores.filter((score) => score.evaluated).length;
  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        manifest: validatedManifest,
        requestedProvider,
        limit,
        repositories: repositoryResults.map((repository) => ({
          repositoryId: repository.repositoryId,
          expectedCommit: repository.expectedCommit,
          actualCommit: repository.actualCommit,
          commitVerified: repository.commitVerified,
          provider: repository.provider,
          scan: repository.scan
            ? {
                totalFiles: repository.scan.totalFiles,
                scannedFiles: repository.scan.scannedFiles,
                errorFiles: repository.scan.errorFiles,
              }
            : null,
          scores: repository.scores.map((score) => ({
            id: score.id,
            evaluated: score.evaluated,
            actual: score.actual ?? [],
          })),
        })),
      }),
    )
    .digest('hex');
  return {
    evaluator: {
      name: 'projectmind-hybrid-search',
      version: 1,
      productPath: 'ProjectScanner → KnowledgeGraph → IntentEngine.search',
    },
    manifest: {
      name: validatedManifest.name,
      version: validatedManifest.version,
      access: validatedManifest.access,
      repositories: validatedManifest.repositories.length,
      cases: validatedManifest.cases.length,
      independentlyVerifiedCases,
      pendingLabelCases: validatedManifest.cases.length - independentlyVerifiedCases,
      inputHash,
    },
    repositories: repositoryResults,
    scores: allScores,
    aggregate: aggregateRankingScores(allScores),
    evaluatedCases,
    unknownCases: validatedManifest.cases.filter((item) => item.case.unknown).length,
    durationMs: Date.now() - started,
    limitations: [...limitations],
  };
}

function normalizeRelativePathList(paths) {
  return [...new Set(paths.map(normalizeRelativePath))].filter(isRelativeInsideProject);
}

/** Render product-path results for internal CI artifacts without hiding limits. */
export function renderProductCorpusBenchmarkMarkdown(result) {
  const percent = (value) => `${(value * 100).toFixed(2)}%`;
  const lines = [
    `# ProjectMind Product-Path Benchmark — ${result.manifest.name}`,
    '',
    `- Evaluator: ${result.evaluator.productPath}`,
    `- Input hash: \`${result.manifest.inputHash}\``,
    `- Repositories: ${result.manifest.repositories}`,
    `- Cases: ${result.manifest.cases}`,
    `- Evaluated cases: ${result.evaluatedCases}`,
    `- Duration: ${result.durationMs} ms`,
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| Precision@k | ${percent(result.aggregate.precisionAtK)} |`,
    `| Recall@k | ${percent(result.aggregate.recallAtK)} |`,
    `| F1 | ${percent(result.aggregate.f1)} |`,
    `| MRR | ${percent(result.aggregate.mrr)} |`,
    `| nDCG | ${percent(result.aggregate.ndcg)} |`,
    '',
    '| Repository | Commit | Scan | Cases |',
    '| --- | --- | ---: | ---: |',
  ];
  for (const repository of result.repositories) {
    const scan = repository.scan
      ? `${repository.scan.scannedFiles}/${repository.scan.totalFiles} (${repository.scan.errorFiles} errors)`
      : 'not run';
    lines.push(
      `| ${repository.repositoryId} | ${repository.commitVerified ? 'verified' : 'unverified'} | ${scan} | ${repository.scores.length} |`,
    );
  }
  if (result.limitations.length > 0) {
    lines.push('', '## Limitations', '');
    for (const limitation of result.limitations) lines.push(`- ${limitation}`);
  }
  return `${lines.join('\n')}\n`;
}
