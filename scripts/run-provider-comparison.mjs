import { mkdir, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { parseBenchmarkCorpusManifest } from './benchmark/manifest.mjs';
import {
  renderProviderComparisonMarkdown,
  runProviderComparison,
} from './benchmark/provider-comparison.mjs';
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
const providers = (readOption(args, '--providers') ?? 'simple')
  .split(',')
  .map((provider) => provider.trim())
  .filter(Boolean);
const baselineProvider = readOption(args, '--baseline');
const verifyCommits = !args.includes('--skip-commit-check');

if (!checkoutRoot || providers.length === 0) {
  console.error(
    'Usage: node scripts/run-provider-comparison.mjs --root <checkout-root> [--providers simple,transformers] [--baseline simple] [--report <file>] [--skip-commit-check]',
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
  const result = await runProviderComparison(manifest, repositoryRoots, {
    providers,
    baselineProvider,
    verifyCommits,
  });
  const report = renderProviderComparisonMarkdown(result);
  if (reportPath) {
    const absoluteReportPath = resolve(reportPath);
    await mkdir(dirname(absoluteReportPath), { recursive: true });
    await writeFile(absoluteReportPath, report, 'utf8');
  }
  console.log(
    JSON.stringify(
      {
        benchmark: result.benchmark,
        baselineProvider: result.baselineProvider,
        inputHash: result.inputHash,
        complete: result.complete,
        providers: result.comparisons.map((comparison) => ({
          provider: comparison.provider,
          status: comparison.status,
          evaluatedCases: comparison.evaluatedCases ?? 0,
          inputHash: comparison.inputHash ?? null,
          error: comparison.error ?? null,
        })),
        reportPath: reportPath ? resolve(reportPath) : null,
      },
      null,
      2,
    ),
  );
  if (!result.complete) process.exitCode = 1;
}
