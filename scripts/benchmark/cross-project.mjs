import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBenchmarkCorpusManifest } from './manifest.mjs';

const DEFAULT_REPOSITORIES = ['zod', 'execa'];
const DEFAULT_TIMEOUT_MS = 120_000;

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function hasFlag(args, name) {
  return args.includes(name);
}

function normalizePath(value) {
  return value.replace(/\\/g, '/');
}

function pathInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function getCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function parseCreatedProjectId(output) {
  const match = /created with ID (\d+)/iu.exec(output);
  if (!match) throw new Error('CLI project create did not return a project ID.');
  return Number(match[1]);
}

function runCli(cliPath, storeRoot, args) {
  const result = execFileSync(process.execPath, [cliPath, ...args], {
    cwd: storeRoot,
    env: {
      ...process.env,
      PROJECTMIND_ROOT: storeRoot,
      PROJECTMIND_MACHINE: '1',
      NO_COLOR: '1',
    },
    encoding: 'utf8',
    timeout: DEFAULT_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result;
}

function runJsonCli(cliPath, storeRoot, args) {
  const stdout = runCli(cliPath, storeRoot, [...args, '--json']);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `CLI command returned invalid JSON (${args.join(' ')}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getRows(database, projectIds) {
  const placeholders = projectIds.map(() => '?').join(',');
  return database
    .prepare(
      `SELECT project_id, path, relative_path, hash, size_bytes
       FROM files WHERE project_id IN (${placeholders})
       ORDER BY project_id, relative_path`,
    )
    .all(...projectIds);
}

/**
 * Verify the actual CLI project store against two immutable corpus checkouts.
 * This is maintainer-only plumbing: it does not add a public command or copy
 * third-party source into the ProjectMind repository.
 */
export function evaluateCrossProjectRows(database, projectRecords) {
  const projectIds = projectRecords.map((project) => project.projectId);
  const rows = getRows(database, projectIds);
  const rowsByProject = Object.fromEntries(projectIds.map((id) => [String(id), 0]));
  const pathsConfined = [];
  const relativePathOwners = new Map();

  for (const row of rows) {
    const project = projectRecords.find((item) => item.projectId === Number(row.project_id));
    if (!project) continue;
    rowsByProject[String(project.projectId)]++;
    const absolutePath = String(row.path);
    const confined = pathInside(project.checkoutPath, absolutePath);
    pathsConfined.push({
      projectId: project.projectId,
      relativePath: normalizePath(String(row.relative_path)),
      confined,
    });
    const relativePath = normalizePath(String(row.relative_path));
    const owners = relativePathOwners.get(relativePath) ?? [];
    owners.push(project.projectId);
    relativePathOwners.set(relativePath, owners);
  }

  const overlappingRelativePaths = [...relativePathOwners.entries()]
    .filter(([, owners]) => new Set(owners).size > 1)
    .map(([relativePath, owners]) => ({
      relativePath,
      projectIds: [...new Set(owners)].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const allPathsConfined = pathsConfined.every((item) => item.confined);
  const everyProjectHasRows = projectRecords.every(
    (project) => rowsByProject[String(project.projectId)] > 0,
  );
  const projectIdsAreDistinct = new Set(projectIds).size === projectIds.length;

  return {
    rowCount: rows.length,
    rowsByProject,
    projectIdsAreDistinct,
    everyProjectHasRows,
    allPathsConfined,
    overlappingRelativePaths,
    pathChecks: pathsConfined,
    passed: projectIdsAreDistinct && everyProjectHasRows && allPathsConfined,
  };
}

export async function runCrossProjectCliCheck(options = {}) {
  const manifestPath = options.manifestPath ?? 'benchmarks/private-20-repository.manifest.json';
  const manifest = parseBenchmarkCorpusManifest(
    JSON.parse(readFileSync(resolve(manifestPath), 'utf8')),
  );
  const repositoryIds = options.repositoryIds ?? DEFAULT_REPOSITORIES;
  if (repositoryIds.length < 2)
    throw new Error('Cross-project check requires at least two repositories.');
  const repositories = repositoryIds.map((id) => {
    const repository = manifest.repositories.find((item) => item.id === id);
    if (!repository) throw new Error(`Repository ${id} is not present in ${manifestPath}.`);
    return repository;
  });
  const corpusRoot = resolve(options.corpusRoot ?? '');
  const cliPath = resolve(options.cliPath ?? 'dist/cli.js');
  if (!existsSync(cliPath)) throw new Error(`Built CLI is missing: ${cliPath}`);

  const checkoutRecords = repositories.map((repository) => {
    const checkoutPath = resolve(corpusRoot, repository.id);
    if (!existsSync(checkoutPath) || !statSync(checkoutPath).isDirectory()) {
      throw new Error(`Corpus checkout is missing: ${checkoutPath}`);
    }
    const actualCommit = getCommit(checkoutPath);
    if (
      !options.skipCommitCheck &&
      actualCommit?.toLowerCase() !== repository.commitSha.toLowerCase()
    ) {
      throw new Error(
        `Corpus checkout ${repository.id} is at ${actualCommit ?? '(unavailable)'}, expected ${repository.commitSha}.`,
      );
    }
    return { repository, checkoutPath, actualCommit };
  });

  const storeRoot = options.storeRoot
    ? resolve(options.storeRoot)
    : join(
        resolve(process.env.TEMP ?? process.cwd()),
        `projectmind-cross-project-${Date.now()}-${process.pid}`,
      );
  mkdirSync(storeRoot, { recursive: true });
  const started = Date.now();
  const projectRecords = [];
  let database;
  try {
    for (const record of checkoutRecords) {
      const output = runCli(cliPath, storeRoot, [
        'project',
        'create',
        `cross-${record.repository.id}`,
        record.checkoutPath,
      ]);
      const projectId = parseCreatedProjectId(output);
      const scan = runJsonCli(cliPath, storeRoot, [
        'scan',
        '--project',
        String(projectId),
        '--full',
      ]);
      projectRecords.push({
        projectId,
        repositoryId: record.repository.id,
        checkoutPath: record.checkoutPath,
        expectedCommit: record.repository.commitSha,
        actualCommit: record.actualCommit,
        scan: {
          scanned: scan.scanned,
          errors: scan.errors,
          totalFiles: scan.totalFiles,
        },
      });
      if (scan.errors !== 0) {
        throw new Error(`Project ${record.repository.id} scan returned ${scan.errors} error(s).`);
      }
    }

    database = new DatabaseSync(join(storeRoot, '.projectmind', 'pm-knowledge.db'), {
      readOnly: true,
    });
    const isolation = evaluateCrossProjectRows(database, projectRecords);
    if (!isolation.passed) {
      throw new Error(
        `Cross-project isolation failed: ${JSON.stringify({
          projectIdsAreDistinct: isolation.projectIdsAreDistinct,
          everyProjectHasRows: isolation.everyProjectHasRows,
          allPathsConfined: isolation.allPathsConfined,
        })}`,
      );
    }

    const result = {
      evaluator: {
        name: 'projectmind-cli-cross-project-isolation',
        version: 1,
        productPath: 'CLI project create → CLI scan --project → shared SQLite store',
      },
      manifest: {
        name: manifest.name,
        version: manifest.version,
        repositories: repositories.map((repository) => repository.id),
      },
      projects: projectRecords,
      isolation: {
        ...isolation,
        pathChecks: undefined,
      },
      durationMs: Date.now() - started,
      limitations: [
        'This check proves local CLI/database namespace isolation for the selected immutable checkouts; it is not a semantic retrieval-quality benchmark.',
        'Relative paths shared by multiple projects are expected and remain separate because project_id is part of the storage key.',
      ],
    };
    result.inputHash = createHash('sha256')
      .update(
        JSON.stringify({
          manifest: result.manifest,
          projects: result.projects,
          isolation: result.isolation,
        }),
      )
      .digest('hex');
    return result;
  } finally {
    database?.close();
    if (!options.storeRoot) rmSync(storeRoot, { recursive: true, force: true });
  }
}

export function renderCrossProjectMarkdown(result) {
  const lines = [
    '# ProjectMind cross-project isolation check',
    '',
    `- Evaluator: ${result.evaluator.name} v${result.evaluator.version}`,
    `- Input hash: ${result.inputHash}`,
    `- Result: ${result.isolation.passed ? 'PASS' : 'FAIL'}`,
    `- Rows checked: ${result.isolation.rowCount}`,
    `- Duration: ${result.durationMs}ms`,
    '',
    '## Projects',
    '',
    '| Repository | Project ID | Scanned | Errors |',
    '|---|---:|---:|---:|',
  ];
  for (const project of result.projects) {
    lines.push(
      `| ${project.repositoryId} | ${project.projectId} | ${project.scan.scanned} | ${project.scan.errors} |`,
    );
  }
  lines.push(
    '',
    '## Isolation invariants',
    '',
    `- Distinct project IDs: ${result.isolation.projectIdsAreDistinct ? 'yes' : 'no'}`,
    `- Every project has indexed rows: ${result.isolation.everyProjectHasRows ? 'yes' : 'no'}`,
    `- Every stored path is inside its project checkout: ${result.isolation.allPathsConfined ? 'yes' : 'no'}`,
    `- Shared relative paths kept separate: ${result.isolation.overlappingRelativePaths.length > 0 ? `yes (${result.isolation.overlappingRelativePaths.length})` : 'not observed'}`,
    '',
    '## Limitations',
    '',
    ...result.limitations.map((item) => `- ${item}`),
    '',
  );
  return lines.join('\n');
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const corpusRoot = readOption(args, '--root');
  if (!corpusRoot) {
    console.error(
      'Usage: node scripts/benchmark/cross-project.mjs --root <corpus-root> [--repositories id,id] [--report <file>] [--skip-commit-check]',
    );
    process.exitCode = 2;
  } else {
    const repositoryIds = (readOption(args, '--repositories') ?? DEFAULT_REPOSITORIES.join(','))
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    runCrossProjectCliCheck({
      corpusRoot,
      repositoryIds,
      manifestPath: readOption(args, '--manifest'),
      cliPath: readOption(args, '--cli'),
      skipCommitCheck: hasFlag(args, '--skip-commit-check'),
    })
      .then((result) => {
        const reportPath = readOption(args, '--report');
        if (reportPath) {
          mkdirSync(dirname(resolve(reportPath)), { recursive: true });
          writeFileSync(resolve(reportPath), renderCrossProjectMarkdown(result), 'utf8');
        }
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
