import { createHash } from 'node:crypto';
import process from 'node:process';
import {
  createContextTokenCounter,
  estimateContextTokens,
} from '../../dist/core/context/tokenizer.js';

const DEFAULT_CASES = Object.freeze([
  {
    id: 'typescript-types',
    text: 'export type UserId = string;\nexport interface User { id: UserId; active: boolean }\n',
  },
  {
    id: 'javascript-control-flow',
    text: 'export function sum(values) { return values.filter(Boolean).reduce((total, value) => total + value, 0); }\n',
  },
  {
    id: 'unicode-identifiers',
    text: 'export const kullanıcıEtiketi = "örnek";\nexport const 東京 = { enabled: true };\n',
  },
  {
    id: 'configuration-json',
    text: '{ "compilerOptions": { "strict": true, "module": "NodeNext" }, "include": ["src/**/*.ts"] }\n',
  },
]);

function normalizeRepeats(value) {
  const repeats = Number(value ?? 3);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20) {
    throw new Error('Tokenizer benchmark repeats must be an integer between 1 and 20.');
  }
  return repeats;
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0
  );
}

function hashCases(cases) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        cases.map((item) => ({
          id: item.id,
          bytes: Buffer.byteLength(item.text, 'utf8'),
          hash: createHash('sha256').update(item.text, 'utf8').digest('hex'),
        })),
      ),
    )
    .digest('hex');
}

/**
 * Measure the production context tokenizer without exposing fixture source.
 * This is a maintainer/release script, not a production command or CLI API.
 */
export async function runTokenizerBenchmark(options = {}) {
  const mode = options.mode ?? 'heuristic';
  const model = options.model;
  const repeats = normalizeRepeats(options.repeats);
  if (mode !== 'heuristic' && mode !== 'transformers') {
    throw new Error('Tokenizer benchmark mode must be heuristic or transformers.');
  }
  const cases = options.cases ?? DEFAULT_CASES;
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error('Tokenizer benchmark requires at least one fixture case.');
  }
  if (
    cases.some(
      (item) =>
        !item ||
        typeof item.id !== 'string' ||
        item.id.length === 0 ||
        typeof item.text !== 'string',
    )
  ) {
    throw new Error('Tokenizer benchmark cases require non-empty string id and text fields.');
  }

  const initializationStarted = performance.now();
  const counter = await createContextTokenCounter({ mode, model });
  const initializationMs = roundMs(performance.now() - initializationStarted);
  const measurements = [];

  for (const item of cases) {
    const latencies = [];
    const tokenCounts = [];
    const estimatedTokens = estimateContextTokens(item.text);
    const bytes = Buffer.byteLength(item.text, 'utf8');
    for (let index = 0; index < repeats; index++) {
      const started = performance.now();
      tokenCounts.push(await counter.count(item.text));
      latencies.push(roundMs(performance.now() - started));
    }
    const actualTokens = tokenCounts.at(-1) ?? 0;
    const stable = tokenCounts.every((value) => value === actualTokens);
    measurements.push({
      id: item.id,
      bytes,
      estimatedTokens,
      providerTokens: actualTokens,
      deltaTokens: actualTokens - estimatedTokens,
      ratio: estimatedTokens > 0 ? actualTokens / estimatedTokens : null,
      stable,
      latencyMs: {
        p50: roundMs(percentile(latencies, 0.5)),
        p95: roundMs(percentile(latencies, 0.95)),
        p99: roundMs(percentile(latencies, 0.99)),
      },
    });
  }

  const estimatedTotal = measurements.reduce((sum, item) => sum + item.estimatedTokens, 0);
  const providerTotal = measurements.reduce((sum, item) => sum + item.providerTokens, 0);
  const allLatencies = measurements.flatMap((item) => [item.latencyMs.p50, item.latencyMs.p95]);
  const limitations = [
    ...counter.limitations,
    'Provider billing may add chat-template, system-prompt or transport overhead not represented by source token counts.',
    'This fixture measures tokenizer behavior, not embedding or LLM response quality.',
  ];
  if (measurements.some((item) => !item.stable)) {
    limitations.push('At least one tokenizer case returned changing counts across repeated calls.');
  }

  return {
    benchmark: 'projectmind-context-tokenizer',
    version: 1,
    mode: counter.mode,
    model: counter.model,
    initializationMs,
    repeats,
    inputHash: hashCases(cases),
    cases: measurements,
    aggregate: {
      fixtureCount: measurements.length,
      bytes: measurements.reduce((sum, item) => sum + item.bytes, 0),
      estimatedTokens: estimatedTotal,
      providerTokens: providerTotal,
      deltaTokens: providerTotal - estimatedTotal,
      ratio: estimatedTotal > 0 ? providerTotal / estimatedTotal : null,
      latencyMs: {
        p50: roundMs(percentile(allLatencies, 0.5)),
        p95: roundMs(percentile(allLatencies, 0.95)),
        p99: roundMs(percentile(allLatencies, 0.99)),
      },
    },
    limitations,
  };
}

export function renderTokenizerBenchmarkMarkdown(result) {
  const aggregate = result.aggregate;
  return [
    '# ProjectMind context tokenizer benchmark',
    '',
    `- Mode: ${result.mode}`,
    `- Model: ${result.model ?? '(heuristic)'}`,
    `- Input hash: \`${result.inputHash}\``,
    `- Initialization: ${result.initializationMs} ms`,
    `- Repeats per fixture: ${result.repeats}`,
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| Fixtures | ${aggregate.fixtureCount} |`,
    `| UTF-8 bytes | ${aggregate.bytes} |`,
    `| Heuristic tokens | ${aggregate.estimatedTokens} |`,
    `| Provider tokens | ${aggregate.providerTokens} |`,
    `| Token delta | ${aggregate.deltaTokens} |`,
    `| Token ratio | ${aggregate.ratio?.toFixed(4) ?? 'n/a'} |`,
    `| p50 latency | ${aggregate.latencyMs.p50} ms |`,
    `| p95 latency | ${aggregate.latencyMs.p95} ms |`,
    `| p99 latency | ${aggregate.latencyMs.p99} ms |`,
    '',
    '## Limitations',
    '',
    ...result.limitations.map((limitation) => `- ${limitation}`),
  ].join('\n');
}

function readOption(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && process.argv[1].endsWith('tokenizer.mjs')) {
  const args = process.argv.slice(2);
  const mode = readOption(args, '--tokenizer') ?? 'heuristic';
  const model = readOption(args, '--model');
  const repeats = readOption(args, '--repeats');
  try {
    const result = await runTokenizerBenchmark({ mode, model, repeats });
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else console.log(renderTokenizerBenchmarkMarkdown(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
