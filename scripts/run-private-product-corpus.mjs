import { mkdir, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { parseBenchmarkCorpusManifest } from './benchmark/manifest.mjs';
import {
  renderProductCorpusBenchmarkMarkdown,
  runProductCorpusBenchmark,
} from './benchmark/product.mjs';
import { evaluateBenchmarkGate } from './benchmark/gate.mjs';
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
const requestedProvider = readOption(args, '--provider') ?? 'simple';
const verifyCommits = !args.includes('--skip-commit-check');
const minimumEvaluatedCasesOption = readOption(args, '--minimum-evaluated-cases');
const minimumEvaluatedCases = minimumEvaluatedCasesOption
  ? Number.parseInt(minimumEvaluatedCasesOption, 10)
  : undefined;

if (!checkoutRoot) {
  console.error(
    'Usage: node scripts/run-private-product-corpus.mjs --root <checkout-root> [--manifest <file>] [--report <file>] [--provider simple|transformers] [--minimum-evaluated-cases <n>] [--skip-commit-check]',
  );
  process.exitCode = 2;
} else {
  const manifest = parseBenchmarkCorpusManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  if (
    minimumEvaluatedCases !== undefined &&
    (!Number.isSafeInteger(minimumEvaluatedCases) ||
      minimumEvaluatedCases < 1 ||
      minimumEvaluatedCases > manifest.cases.length)
  ) {
    console.error(
      `--minimum-evaluated-cases must be an integer between 1 and ${manifest.cases.length}.`,
    );
    process.exitCode = 2;
  } else {
    const repositoryRoots = Object.fromEntries(
      manifest.repositories.map((repository) => [
        repository.id,
        join(resolve(checkoutRoot), repository.id),
      ]),
    );
    const result = await runProductCorpusBenchmark(manifest, repositoryRoots, {
      verifyCommits,
      provider: requestedProvider,
    });
    const metadataGate = evaluateBenchmarkGate(result, {
      minimumEvaluatedCases: minimumEvaluatedCases ?? manifest.cases.length,
      requireVerifiedCommits: verifyCommits,
    });
    const publicGate = evaluateBenchmarkGate(result, {
      minimumEvaluatedCases: minimumEvaluatedCases ?? manifest.cases.length,
      requireVerifiedCommits: verifyCommits,
      requireIndependentLabels: true,
    });
    const report = renderProductCorpusBenchmarkMarkdown(result);
    if (reportPath) {
      const absoluteReportPath = resolve(reportPath);
      await mkdir(dirname(absoluteReportPath), { recursive: true });
      await writeFile(absoluteReportPath, report, 'utf8');
    }
    console.log(
      JSON.stringify(
        {
          evaluator: result.evaluator,
          manifest: result.manifest,
          aggregate: result.aggregate,
          evaluatedCases: result.evaluatedCases,
          unknownCases: result.unknownCases,
          verifiedRepositories: result.repositories.filter(
            (repository) => repository.commitVerified,
          ).length,
          metadataGate,
          publicGate,
          reportPath: reportPath ? resolve(reportPath) : null,
        },
        null,
        2,
      ),
    );
    if (!metadataGate.passed) process.exitCode = 1;
  }
}
