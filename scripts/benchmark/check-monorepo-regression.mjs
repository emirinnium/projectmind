import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function readOption(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** Check invariant fields while leaving hardware-dependent timings informative. */
export function evaluateMonorepoRegression(current, baseline) {
  const failures = [];
  if (!current || typeof current !== 'object') failures.push('Current monorepo result is missing.');
  if (!baseline || typeof baseline !== 'object') failures.push('Monorepo baseline is missing.');
  if (failures.length > 0) return { passed: false, failures };

  if (current.evaluator?.name !== baseline.evaluatorName) {
    failures.push(
      `Evaluator changed from ${baseline.evaluatorName} to ${current.evaluator?.name ?? '(missing)'}.`,
    );
  }
  for (const field of ['fileCount', 'packageCount', 'inputHash']) {
    if (
      baseline.fixture?.[field] !== undefined &&
      current.fixture?.[field] !== baseline.fixture[field]
    ) {
      failures.push(
        `Fixture ${field} changed from ${baseline.fixture[field]} to ${current.fixture?.[field] ?? '(missing)'}.`,
      );
    }
  }
  for (const phase of ['full', 'incremental']) {
    const expected = baseline[phase];
    const actual = current[phase];
    if (!actual) {
      failures.push(`${phase} result is missing.`);
      continue;
    }
    for (const field of ['totalFiles', 'scannedFiles', 'errorFiles']) {
      if (expected?.[field] !== undefined && actual[field] !== expected[field]) {
        failures.push(
          `${phase}.${field} changed from ${expected[field]} to ${actual[field] ?? '(missing)'}.`,
        );
      }
    }
  }
  if (baseline.requirePassed !== false && current.passed !== true) {
    failures.push('Monorepo completeness invariant did not pass.');
  }
  return { passed: failures.length === 0, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const currentPath = readOption(args, '--current');
  const baselinePath = readOption(args, '--baseline');
  if (!currentPath || !baselinePath) {
    console.error(
      'Usage: node scripts/benchmark/check-monorepo-regression.mjs --current <result.json> --baseline <baseline.json>',
    );
    process.exitCode = 2;
  } else {
    Promise.all([
      readFile(resolve(currentPath), 'utf8').then((value) => JSON.parse(value)),
      readFile(resolve(baselinePath), 'utf8').then((value) => JSON.parse(value)),
    ])
      .then(([current, baseline]) => {
        const result = evaluateMonorepoRegression(current, baseline);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (!result.passed) process.exitCode = 1;
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
