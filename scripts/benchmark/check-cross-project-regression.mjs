import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function readOption(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** Fail closed when the real CLI isolation evaluator loses its contract. */
export function evaluateCrossProjectRegression(current, baseline) {
  const failures = [];
  if (!current || typeof current !== 'object')
    failures.push('Current cross-project result is missing.');
  if (!baseline || typeof baseline !== 'object')
    failures.push('Cross-project baseline is missing.');
  if (failures.length > 0) return { passed: false, failures };

  if (baseline.evaluatorName && current.evaluator?.name !== baseline.evaluatorName) {
    failures.push(
      `Evaluator changed from ${baseline.evaluatorName} to ${current.evaluator?.name ?? '(missing)'}.`,
    );
  }
  const currentRepositories = current.manifest?.repositories;
  const expectedRepositories = baseline.repositories;
  if (!Array.isArray(currentRepositories) || !Array.isArray(expectedRepositories)) {
    failures.push('Current or baseline repository list is missing.');
  } else if (
    JSON.stringify([...currentRepositories].sort()) !==
    JSON.stringify([...expectedRepositories].sort())
  ) {
    failures.push(
      `Repository set changed from ${expectedRepositories.join(', ')} to ${currentRepositories.join(', ')}.`,
    );
  }
  if (baseline.requirePassed !== false && current.isolation?.passed !== true) {
    failures.push('Cross-project isolation invariant did not pass.');
  }
  if (baseline.requireCommitParity !== false) {
    for (const project of current.projects ?? []) {
      if (
        !project.actualCommit ||
        project.actualCommit.toLowerCase() !== String(project.expectedCommit).toLowerCase()
      ) {
        failures.push(`Commit verification failed for ${project.repositoryId}.`);
      }
    }
  }
  const maxScanErrors = Number.isFinite(baseline.maxScanErrors) ? baseline.maxScanErrors : 0;
  for (const project of current.projects ?? []) {
    if (Number(project.scan?.errors ?? 0) > maxScanErrors) {
      failures.push(
        `${project.repositoryId} scan errors ${project.scan?.errors ?? '(missing)'} exceed ${maxScanErrors}.`,
      );
    }
  }
  return { passed: failures.length === 0, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const currentPath = readOption(args, '--current');
  const baselinePath = readOption(args, '--baseline');
  if (!currentPath || !baselinePath) {
    console.error(
      'Usage: node scripts/benchmark/check-cross-project-regression.mjs --current <result.json> --baseline <baseline.json>',
    );
    process.exitCode = 2;
  } else {
    Promise.all([
      readFile(resolve(currentPath), 'utf8').then((value) => JSON.parse(value)),
      readFile(resolve(baselinePath), 'utf8').then((value) => JSON.parse(value)),
    ])
      .then(([current, baseline]) => {
        const result = evaluateCrossProjectRegression(current, baseline);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (!result.passed) process.exitCode = 1;
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
