import { mkdir, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { parseBenchmarkCorpusManifest } from './benchmark/manifest.mjs';
import {
  renderExternalProviderMarkdown,
  runExternalProviderCorpusBenchmark,
} from './benchmark/external-provider.mjs';

function readOption(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const manifestPath = resolve(
  readOption(args, '--manifest') ?? 'benchmarks/private-5-repository.manifest.json',
);
const checkoutRoot = readOption(args, '--root');
const reportPath = readOption(args, '--report');
const model = readOption(args, '--model');
const providerName = readOption(args, '--provider') ?? 'openrouter';
const apiKey = process.env.OPENROUTER_API_KEY;
const maxTokens = Number(readOption(args, '--max-tokens') ?? 256);
const reasoningEffort = readOption(args, '--reasoning-effort');

async function readPricing() {
  if (providerName !== 'openrouter' || !apiKey) return undefined;
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return undefined;
  const data = await response.json();
  const modelInfo = Array.isArray(data?.data) ? data.data.find((item) => item?.id === model) : null;
  const inputPerToken = Number(modelInfo?.pricing?.prompt);
  const outputPerToken = Number(modelInfo?.pricing?.completion);
  if (!Number.isFinite(inputPerToken) || !Number.isFinite(outputPerToken)) return undefined;
  return { inputPerToken, outputPerToken, source: 'https://openrouter.ai/api/v1/models' };
}

if (!checkoutRoot || !model || !apiKey) {
  console.error(
    'Usage: OPENROUTER_API_KEY=<key> node scripts/run-external-provider-benchmark.mjs --root <checkout-root> --model <provider/model> [--reasoning-effort none|minimal|low|medium|high|xhigh] [--max-tokens <n>] [--manifest <file>] [--report <file>] [--skip-commit-check]',
  );
  process.exitCode = 2;
} else {
  const manifest = parseBenchmarkCorpusManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const repositoryRoots = Object.fromEntries(
    manifest.repositories.map((repository) => [repository.id, join(resolve(checkoutRoot), repository.id)]),
  );
  const result = await runExternalProviderCorpusBenchmark(manifest, repositoryRoots, {
    model,
    providerName,
    apiKey,
    maxTokens,
    reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
    pricing: await readPricing(),
    verifyCommits: !args.includes('--skip-commit-check'),
  });
  const report = renderExternalProviderMarkdown(result);
  if (reportPath) {
    const absoluteReportPath = resolve(reportPath);
    await mkdir(dirname(absoluteReportPath), { recursive: true });
    await writeFile(absoluteReportPath, report, 'utf8');
  }
  console.log(
    JSON.stringify(
      {
        benchmark: result.benchmark,
        provider: result.provider,
        pricing: result.pricing,
        labelStatus: result.labelStatus,
        evaluatedCases: result.evaluatedCases,
        aggregate: result.aggregate,
        repositories: result.repositories.map((repository) => ({
          repositoryId: repository.repositoryId,
          status: repository.status,
          cases: repository.cases.length,
        })),
        reportPath: reportPath ? resolve(reportPath) : null,
      },
      null,
      2,
    ),
  );
}
