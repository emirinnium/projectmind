import { mkdir, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { parseBenchmarkCorpusManifest } from './benchmark/manifest.mjs';
import {
  renderSecurityCorpusBenchmarkMarkdown,
  runSecurityCorpusBenchmark,
} from './benchmark/security-corpus.mjs';
import { logger } from '../dist/utils/logger.js';

logger.setMachineMode(true);

function readOption(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const manifestPath = resolve(
  readOption(args, '--manifest') ?? 'benchmarks/private-20-repository.manifest.json',
);
const checkoutRoot = readOption(args, '--root');
const reportPath = readOption(args, '--report');
const includeTests = args.includes('--include-tests');

if (!checkoutRoot) {
  console.error(
    'Usage: node scripts/run-private-security-corpus.mjs --root <checkout-root> [--report <file>] [--include-tests]',
  );
  process.exitCode = 2;
} else {
  const manifest = parseBenchmarkCorpusManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const repositoryRoots = Object.fromEntries(
    manifest.repositories.map((repository) => [
      repository.id,
      join(resolve(checkoutRoot), repository.id),
    ]),
  );
  const result = runSecurityCorpusBenchmark(manifest, repositoryRoots, {
    verifyCommits: true,
    includeTests,
  });
  const report = renderSecurityCorpusBenchmarkMarkdown(result);
  if (reportPath) {
    const absoluteReportPath = resolve(reportPath);
    await mkdir(dirname(absoluteReportPath), { recursive: true });
    await writeFile(absoluteReportPath, report, 'utf8');
  }
  console.log(
    JSON.stringify(
      {
        benchmark: result.benchmark,
        manifest: result.manifest,
        filesScanned: result.filesScanned,
        filesSkipped: result.filesSkipped,
        bySeverity: result.bySeverity,
        candidateFindings: result.candidateFindings,
        verifiedRepositories: result.repositories.filter((repository) => repository.commitVerified)
          .length,
        limitations: result.limitations,
        reportPath: reportPath ? resolve(reportPath) : null,
      },
      null,
      2,
    ),
  );
  if (
    result.repositories.some((repository) => !repository.commitVerified) ||
    result.repositories.length !== manifest.repositories.length
  ) {
    process.exitCode = 1;
  }
}
