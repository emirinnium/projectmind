import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { resolve } from 'node:path';
import { evaluateBenchmarkRegression } from './regression.mjs';

function readOption(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const currentPath = readOption(args, '--current');
const baselinePath = readOption(args, '--baseline');
const runner = readOption(args, '--runner') ?? 'default';

if (!currentPath || !baselinePath) {
  console.error(
    'Usage: node scripts/benchmark/check-regression.mjs --current <result.json> --baseline <baseline.json> [--runner <name>]',
  );
  process.exitCode = 2;
} else {
  const current = JSON.parse(await readFile(resolve(currentPath), 'utf8'));
  const baseline = JSON.parse(await readFile(resolve(baselinePath), 'utf8'));
  const result = evaluateBenchmarkRegression(current, baseline, {
    runner,
    maxMetricDrop: baseline.policy?.maxMetricDrop,
    requireInputHash: baseline.policy?.requireInputHash,
    requireEvaluatedCaseParity: baseline.policy?.requireEvaluatedCaseParity,
    maxScanErrors: baseline.policy?.maxScanErrors,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
