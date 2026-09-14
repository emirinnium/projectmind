import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initDatabase } from '../../dist/storage/database.js';
import { ProjectScanner } from '../../dist/core/scale/reporting/scanner.js';
import { logger } from '../../dist/utils/logger.js';

const DEFAULT_FILE_COUNT = 240;
const DEFAULT_PACKAGE_COUNT = 12;

function boundedInteger(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

/**
 * Measure a synthetic JS/TS monorepo boundary through the real scanner. The
 * fixture is disposable and source is never copied into the repository or a
 * report; only counts, timings and a fixture hash are retained.
 */
export async function runMonorepoBenchmark(options = {}) {
  const fileCount = boundedInteger(options.fileCount, DEFAULT_FILE_COUNT, 1, 2_000, 'fileCount');
  const packageCount = boundedInteger(
    options.packageCount,
    DEFAULT_PACKAGE_COUNT,
    1,
    Math.min(fileCount, 100),
    'packageCount',
  );
  const root = mkdtempSync(join(tmpdir(), 'projectmind-monorepo-evaluator-'));
  const fixtureHashes = [];
  const started = Date.now();
  try {
    for (let index = 0; index < fileCount; index++) {
      const packageName = `package-${String(index % packageCount).padStart(3, '0')}`;
      const packageRoot = join(root, 'packages', packageName, 'src');
      mkdirSync(packageRoot, { recursive: true });
      const previous =
        index > 0
          ? `import { value as previous } from './module-${String(index - 1).padStart(4, '0')}';\n`
          : '';
      const content = `${previous}export const value = ${index};\n`;
      writeFileSync(
        join(packageRoot, `module-${String(index).padStart(4, '0')}.ts`),
        content,
        'utf8',
      );
      fixtureHashes.push({ index, hash: createHash('sha256').update(content).digest('hex') });
    }

    initDatabase(':memory:');
    const scanner = new ProjectScanner();
    const full = await scanner.scanProjectWithProfile(root, true);
    const incremental = await scanner.scanProjectWithProfile(root, false);
    const result = {
      evaluator: { name: 'projectmind-monorepo-boundary', version: 1 },
      fixture: {
        fileCount,
        packageCount,
        inputHash: createHash('sha256').update(JSON.stringify(fixtureHashes)).digest('hex'),
      },
      full: {
        totalFiles: full.totalFiles,
        scannedFiles: full.scannedFiles,
        errorFiles: full.errorFiles,
        durationMs: full.durationMs,
        filesPerSecond: full.filesPerSecond,
      },
      incremental: {
        totalFiles: incremental.totalFiles,
        scannedFiles: incremental.scannedFiles,
        errorFiles: incremental.errorFiles,
        durationMs: incremental.durationMs,
        filesPerSecond: incremental.filesPerSecond,
      },
      durationMs: Date.now() - started,
      passed:
        full.totalFiles === fileCount &&
        full.scannedFiles === fileCount &&
        full.errorFiles === 0 &&
        incremental.totalFiles === fileCount &&
        incremental.scannedFiles === 0 &&
        incremental.errorFiles === 0,
      limitations: [
        'This is a bounded synthetic monorepo boundary, not a claim about every repository shape or hardware profile.',
        'Absolute timings are reported for trend analysis; the pass/fail contract is based on scan completeness and error-free incremental behavior.',
      ],
    };
    if (!result.passed)
      throw new Error(`Monorepo benchmark invariant failed: ${JSON.stringify(result)}`);
    return result;
  } finally {
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
  }
}

function readOption(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function renderMarkdown(result) {
  return [
    '# ProjectMind monorepo boundary benchmark',
    '',
    `- Evaluator: ${result.evaluator.name} v${result.evaluator.version}`,
    `- Fixture: ${result.fixture.fileCount} files / ${result.fixture.packageCount} packages`,
    `- Fixture hash: \`${result.fixture.inputHash}\``,
    `- Result: ${result.passed ? 'PASS' : 'FAIL'}`,
    '',
    '| Pass | Total files | Scanned | Errors | Duration |',
    '|---|---:|---:|---:|---:|',
    `| Full | ${result.full.totalFiles} | ${result.full.scannedFiles} | ${result.full.errorFiles} | ${result.full.durationMs} ms |`,
    `| Incremental | ${result.incremental.totalFiles} | ${result.incremental.scannedFiles} | ${result.incremental.errorFiles} | ${result.incremental.durationMs} ms |`,
    '',
    '## Limitations',
    '',
    ...result.limitations.map((item) => `- ${item}`),
    '',
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  logger.setMachineMode(true);
  runMonorepoBenchmark({
    fileCount: readOption(args, '--files'),
    packageCount: readOption(args, '--packages'),
  })
    .then((result) => {
      const reportPath = readOption(args, '--report');
      if (reportPath) {
        mkdirSync(dirname(resolve(reportPath)), { recursive: true });
        writeFileSync(resolve(reportPath), renderMarkdown(result), 'utf8');
      }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
