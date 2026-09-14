import { mkdir, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { resolve, join, dirname } from 'node:path';
import { parseBenchmarkCorpusManifest } from './benchmark/manifest.mjs';
import { runCorpusBenchmark, renderCorpusBenchmarkMarkdown } from './benchmark/runner.mjs';
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
const requireIndependentLabels = args.includes('--require-independent-labels');

if (!checkoutRoot) {
  console.error(
    'Usage: node scripts/run-private-corpus.mjs --root <checkout-root> [--report <file>]',
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
  const result = runCorpusBenchmark(manifest, repositoryRoots, { verifyCommits: true });
  const metadataGate = evaluateBenchmarkGate(result, {
    minimumEvaluatedCases: manifest.cases.length,
    requireVerifiedCommits: true,
  });
  const publicGate = evaluateBenchmarkGate(result, {
    minimumEvaluatedCases: manifest.cases.length,
    requireVerifiedCommits: true,
    requireIndependentLabels: true,
  });
  const report = renderCorpusBenchmarkMarkdown(result);
  if (reportPath) {
    const absoluteReportPath = resolve(reportPath);
    await mkdir(dirname(absoluteReportPath), { recursive: true });
    await writeFile(absoluteReportPath, `${report}\n`, 'utf8');
  }
  console.log(
    JSON.stringify(
      {
        manifest: result.manifest,
        aggregate: result.aggregate,
        evaluatedCases: result.evaluatedCases,
        unknownCases: result.unknownCases,
        verifiedRepositories: result.repositories.filter((repository) => repository.commitVerified)
          .length,
        metadataGate,
        publicGate,
        reportPath: reportPath ? resolve(reportPath) : null,
      },
      null,
      2,
    ),
  );
  if (!metadataGate.passed || (requireIndependentLabels && !publicGate.passed))
    process.exitCode = 1;
}
