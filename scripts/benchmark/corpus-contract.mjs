import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBenchmarkCorpusManifest } from './manifest.mjs';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function normalizeRelativePath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//u, '');
}

function isSafeRelativePath(value) {
  const normalized = normalizeRelativePath(value);
  return (
    normalized.length > 0 &&
    normalized !== '..' &&
    !normalized.startsWith('../') &&
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:\//u.test(normalized)
  );
}

function gitHead(checkoutPath) {
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

function gitTrackedFiles(checkoutPath) {
  try {
    const output = execFileSync('git', ['ls-files', '-z'], {
      cwd: checkoutPath,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .split('\0')
      .filter(Boolean)
      .map(normalizeRelativePath)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function sourceLoc(root, relativePath) {
  try {
    const content = readFileSync(resolve(root, relativePath), 'utf8');
    return content
      .split(/\r?\n/u)
      .reduce((count, line) => (line.trim().length > 0 ? count + 1 : count), 0);
  } catch {
    return 0;
  }
}

function sourceMetadata(root, trackedFiles) {
  const sourceFiles = trackedFiles.filter((path) =>
    SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')).toLowerCase()),
  );
  const hashes = sourceFiles.map((path) => {
    let hash = null;
    try {
      hash = createHash('sha256')
        .update(readFileSync(resolve(root, path)))
        .digest('hex');
    } catch {
      // The path is still retained in the result as unreadable metadata.
    }
    return { path, hash, loc: hash ? sourceLoc(root, path) : 0 };
  });
  return {
    fileCount: trackedFiles.length,
    sourceFileCount: sourceFiles.length,
    loc: hashes.reduce((total, item) => total + item.loc, 0),
    inputHash: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),
  };
}

function packageMetadataPaths(root) {
  const packagePath = join(root, 'package.json');
  if (!existsSync(packagePath)) return [];
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    const values = [];
    const visit = (value) => {
      if (typeof value === 'string') {
        const normalized = normalizeRelativePath(value);
        if (
          isSafeRelativePath(normalized) &&
          SOURCE_EXTENSIONS.has(normalized.slice(normalized.lastIndexOf('.')).toLowerCase())
        ) {
          values.push(normalized);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value && typeof value === 'object') {
        for (const item of Object.values(value)) visit(item);
      }
    };
    for (const key of ['main', 'module', 'types', 'typings', 'bin', 'exports'])
      visit(packageJson[key]);
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/**
 * Audit one manifest case against a checkout without claiming semantic truth.
 * Package metadata is supporting evidence only; source/test review remains
 * necessary before a case can become independently verified.
 */
export function evaluateCorpusCaseContract(testCase, evidence) {
  const expectedPaths = testCase.expectedPaths.map(normalizeRelativePath);
  const existingPaths = new Set(evidence.existingPaths ?? []);
  const trackedPaths = new Set(evidence.trackedPaths ?? []);
  const packagePaths = new Set(evidence.packageMetadataPaths ?? []);
  const safe = expectedPaths.every(isSafeRelativePath);
  const present = safe && expectedPaths.every((path) => existingPaths.has(path));
  const tracked = safe && expectedPaths.every((path) => trackedPaths.has(path));
  return {
    id: testCase.id,
    expectedPaths,
    safePaths: safe,
    expectedPathsPresent: present,
    expectedPathsTracked: tracked,
    packageMetadataMatches: expectedPaths.map((path) => ({
      path,
      referenced: packagePaths.has(path),
    })),
    passed: safe && present && tracked,
  };
}

function collectExistingPaths(root) {
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else {
        paths.push(normalizeRelativePath(relative(root, absolutePath)));
      }
    }
  };
  visit(root);
  return paths.sort((left, right) => left.localeCompare(right));
}

/**
 * Validate immutable corpus checkouts and every expected path. No repository
 * is fetched and no source content is included in the returned report.
 */
export function runCorpusContractAudit(manifest, repositoryRoots, options = {}) {
  const validatedManifest = parseBenchmarkCorpusManifest(manifest);
  const verifyCommits = options.verifyCommits ?? true;
  const casesByRepository = new Map();
  for (const item of validatedManifest.cases) {
    const cases = casesByRepository.get(item.repositoryId) ?? [];
    cases.push(item.case);
    casesByRepository.set(item.repositoryId, cases);
  }

  const repositories = [];
  const failures = [];
  for (const repository of validatedManifest.repositories) {
    const checkoutPath = repositoryRoots[repository.id]
      ? resolve(repositoryRoots[repository.id])
      : undefined;
    const exists = Boolean(
      checkoutPath && existsSync(checkoutPath) && statSync(checkoutPath).isDirectory(),
    );
    const actualCommit = exists ? gitHead(checkoutPath) : null;
    const commitVerified =
      exists &&
      (!verifyCommits || actualCommit?.toLowerCase() === repository.commitSha.toLowerCase());
    const trackedPaths = exists ? gitTrackedFiles(checkoutPath) : [];
    const existingPaths = exists ? collectExistingPaths(checkoutPath) : [];
    const metadata = exists ? sourceMetadata(checkoutPath, trackedPaths) : null;
    const packagePaths = exists ? packageMetadataPaths(checkoutPath) : [];
    const caseResults = (casesByRepository.get(repository.id) ?? []).map((testCase) =>
      evaluateCorpusCaseContract(testCase, {
        existingPaths,
        trackedPaths,
        packageMetadataPaths: packagePaths,
      }),
    );
    const repositoryPassed =
      commitVerified && caseResults.length > 0 && caseResults.every((item) => item.passed);
    if (!exists) failures.push(`${repository.id}: checkout is missing.`);
    if (!commitVerified) {
      failures.push(
        `${repository.id}: immutable commit verification failed (expected ${repository.commitSha}, actual ${actualCommit ?? '(unavailable)'}).`,
      );
    }
    for (const item of caseResults) {
      if (!item.passed)
        failures.push(`${repository.id}/${item.id}: expected path contract failed.`);
    }
    repositories.push({
      id: repository.id,
      expectedCommit: repository.commitSha,
      actualCommit,
      commitVerified,
      metadata,
      cases: caseResults,
      passed: repositoryPassed,
    });
  }

  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        manifest: validatedManifest,
        verifyCommits,
        repositories: repositories.map((repository) => ({
          id: repository.id,
          expectedCommit: repository.expectedCommit,
          actualCommit: repository.actualCommit,
          commitVerified: repository.commitVerified,
          metadata: repository.metadata,
          cases: repository.cases,
        })),
      }),
    )
    .digest('hex');

  return {
    evaluator: { name: 'projectmind-corpus-contract', version: 1 },
    manifest: {
      name: validatedManifest.name,
      version: validatedManifest.version,
      access: validatedManifest.access,
      repositories: validatedManifest.repositories.length,
      cases: validatedManifest.cases.length,
      inputHash,
    },
    repositories,
    passed: failures.length === 0,
    failures,
    limitations: [
      'Path presence and package metadata are fixture-integrity evidence, not semantic relevance labels.',
      'This evaluator does not promote single-reviewer labels to independent labels.',
      'Dynamic exports, runtime entry points and behavior still require source/test review or an explicit unknown case.',
    ],
  };
}

export function renderCorpusContractMarkdown(result) {
  const lines = [
    `# ProjectMind corpus contract audit — ${result.manifest.name}`,
    '',
    `- Evaluator: ${result.evaluator.name} v${result.evaluator.version}`,
    `- Result: ${result.passed ? 'PASS' : 'FAIL'}`,
    `- Input hash: \`${result.manifest.inputHash}\``,
    `- Repositories: ${result.manifest.repositories}`,
    `- Cases: ${result.manifest.cases}`,
    '',
    '| Repository | Commit verified | Source files | LOC | Cases |',
    '| --- | :---: | ---: | ---: | ---: |',
    ...result.repositories.map(
      (repository) =>
        `| ${repository.id} | ${repository.commitVerified ? 'yes' : 'no'} | ${repository.metadata?.sourceFileCount ?? 0} | ${repository.metadata?.loc ?? 0} | ${repository.cases.length} |`,
    ),
  ];
  if (result.failures.length > 0)
    lines.push('', '## Failures', '', ...result.failures.map((item) => `- ${item}`));
  lines.push('', '## Limitations', '', ...result.limitations.map((item) => `- ${item}`), '');
  return lines.join('\n');
}

function readOption(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const checkoutRoot = readOption(args, '--root');
  if (!checkoutRoot) {
    console.error(
      'Usage: node scripts/benchmark/corpus-contract.mjs --root <checkout-root> [--manifest <file>] [--report <file>] [--skip-commit-check]',
    );
    process.exitCode = 2;
  } else {
    const manifestPath = resolve(
      readOption(args, '--manifest') ?? 'benchmarks/private-20-repository.manifest.json',
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const repositoryRoots = Object.fromEntries(
      manifest.repositories.map((repository) => [
        repository.id,
        join(resolve(checkoutRoot), repository.id),
      ]),
    );
    const result = runCorpusContractAudit(manifest, repositoryRoots, {
      verifyCommits: !args.includes('--skip-commit-check'),
    });
    const reportPath = readOption(args, '--report');
    if (reportPath) {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(resolve(reportPath)), { recursive: true });
      writeFileSync(resolve(reportPath), renderCorpusContractMarkdown(result), 'utf8');
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.passed) process.exitCode = 1;
  }
}
