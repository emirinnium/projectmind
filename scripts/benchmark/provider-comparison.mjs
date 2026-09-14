import { createHash } from 'node:crypto';
import { parseBenchmarkCorpusManifest } from './manifest.mjs';
import { runProductCorpusBenchmark } from './product.mjs';

const SUPPORTED_PROVIDER_NAMES = new Set([
  'simple',
  'transformers',
  'openai',
  'unixcoder',
  'codebert',
]);

function validateProviders(value) {
  const providers = value ?? ['simple'];
  if (!Array.isArray(providers) || providers.length === 0 || providers.length > 5) {
    throw new Error('Provider comparison requires between 1 and 5 providers.');
  }
  const normalized = providers.map((provider) => String(provider).trim().toLowerCase());
  if (normalized.some((provider) => !SUPPORTED_PROVIDER_NAMES.has(provider))) {
    throw new Error(
      `Unsupported provider comparison name. Use: ${[...SUPPORTED_PROVIDER_NAMES].join(', ')}.`,
    );
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Provider comparison names must be unique.');
  }
  return normalized;
}

function metricDelta(current, baseline) {
  return {
    precisionAtK: current.precisionAtK - baseline.precisionAtK,
    recallAtK: current.recallAtK - baseline.recallAtK,
    f1: current.f1 - baseline.f1,
    mrr: current.mrr - baseline.mrr,
    ndcg: current.ndcg - baseline.ndcg,
  };
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, 500);
}

function safeMarkdown(value) {
  return String(value)
    .replace(/[|\r\n]+/gu, ' ')
    .trim();
}

/**
 * Compare the production retrieval path with independent provider/index runs.
 * This is a maintainer evaluator, not a public CLI and not a model-quality
 * claim: provider fallback, missing labels and runtime limitations remain in
 * the returned evidence.
 */
export async function runProviderComparison(manifest, repositoryRoots, options = {}) {
  const validatedManifest = parseBenchmarkCorpusManifest(manifest);
  const providers = validateProviders(options.providers);
  const baselineProvider = String(options.baselineProvider ?? providers[0]).toLowerCase();
  if (!providers.includes(baselineProvider)) {
    throw new Error(
      `Baseline provider ${baselineProvider} is not in the comparison provider list.`,
    );
  }

  const entries = [];
  for (const provider of providers) {
    try {
      const result = await runProductCorpusBenchmark(validatedManifest, repositoryRoots, {
        ...options,
        provider,
      });
      const providerUsage = result.repositories.map((repository) => ({
        repositoryId: repository.repositoryId,
        requested: repository.provider?.requested ?? provider,
        active: repository.provider?.active ?? null,
        fellBack: repository.provider?.fellBack ?? false,
        limitations: repository.provider?.limitations ?? [],
      }));
      const fellBack = providerUsage.some((usage) => usage.fellBack);
      entries.push({
        provider,
        status: fellBack ? 'fallback' : 'completed',
        result,
        providerUsage,
        activeProviders: [...new Set(providerUsage.map((usage) => usage.active).filter(Boolean))],
      });
    } catch (error) {
      entries.push({ provider, status: 'failed', error: safeError(error) });
    }
  }

  const baseline = entries.find(
    (entry) => entry.provider === baselineProvider && entry.status === 'completed',
  );
  const baselineAggregate = baseline?.result.aggregate;
  const comparisons = entries.map((entry) => {
    if (entry.status === 'failed' || !entry.result) return entry;
    return {
      provider: entry.provider,
      status: entry.status,
      inputHash: entry.result.manifest.inputHash,
      evaluatedCases: entry.result.evaluatedCases,
      aggregate: entry.result.aggregate,
      deltaFromBaseline: baselineAggregate
        ? metricDelta(entry.result.aggregate, baselineAggregate)
        : null,
      activeProviders: entry.activeProviders ?? [],
      providerUsage: entry.providerUsage ?? [],
      limitations: entry.result.limitations,
    };
  });

  const limitations = [
    'Provider deltas compare the same local evaluator and corpus; they do not establish semantic model quality.',
    'A provider fallback is reported as evidence and is not treated as the requested provider result.',
    'Independent golden labels are required before publishing accuracy or provider superiority claims.',
    ...new Set(
      comparisons.flatMap((comparison) =>
        comparison.status === 'failed' ? [comparison.error] : comparison.limitations,
      ),
    ),
  ];
  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        manifest: validatedManifest,
        providers,
        baselineProvider,
        comparisons: comparisons.map((comparison) => ({
          provider: comparison.provider,
          status: comparison.status,
          inputHash: comparison.inputHash ?? null,
          evaluatedCases: comparison.evaluatedCases ?? 0,
        })),
      }),
    )
    .digest('hex');

  return {
    benchmark: 'projectmind-provider-comparison',
    version: 1,
    baselineProvider,
    inputHash,
    complete: comparisons.every((comparison) => comparison.status === 'completed'),
    comparisons,
    limitations,
  };
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

/** Render provider comparison without source content or hidden failures. */
export function renderProviderComparisonMarkdown(result) {
  const lines = [
    '# ProjectMind provider comparison',
    '',
    `- Baseline provider: ${result.baselineProvider}`,
    `- Complete: ${result.complete ? 'yes' : 'no'}`,
    `- Input hash: \`${result.inputHash}\``,
    '',
    '| Provider | Status | Active provider | Evaluated cases | Precision@k | Recall@k | F1 | MRR | nDCG |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const comparison of result.comparisons) {
    if (comparison.status === 'failed') {
      lines.push(
        `| ${safeMarkdown(comparison.provider)} | failed: ${safeMarkdown(comparison.error)} | n/a | 0 | n/a | n/a | n/a | n/a | n/a |`,
      );
      continue;
    }
    const aggregate = comparison.aggregate;
    lines.push(
      `| ${safeMarkdown(comparison.provider)} | ${safeMarkdown(comparison.status)} | ${safeMarkdown((comparison.activeProviders ?? []).join(', ') || 'unavailable')} | ${comparison.evaluatedCases} | ${percent(aggregate.precisionAtK)} | ${percent(aggregate.recallAtK)} | ${percent(aggregate.f1)} | ${percent(aggregate.mrr)} | ${percent(aggregate.ndcg)} |`,
    );
  }
  lines.push(
    '',
    '## Limitations',
    '',
    ...result.limitations.map((item) => `- ${safeMarkdown(item)}`),
  );
  return `${lines.join('\n')}\n`;
}
