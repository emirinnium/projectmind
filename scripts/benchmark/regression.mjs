const REGRESSION_METRICS = Object.freeze(['precisionAtK', 'recallAtK', 'f1', 'mrr', 'ndcg']);

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function selectBaseline(baseline, runner) {
  if (baseline?.baselines && typeof baseline.baselines === 'object') {
    return baseline.baselines[runner] ?? null;
  }
  return baseline;
}

function scanErrorCount(result) {
  if (!Array.isArray(result?.repositories)) return 0;
  return result.repositories.reduce((total, repository) => {
    const errors = finiteNumber(repository?.scan?.errorFiles);
    return total + (errors === null ? 0 : Math.max(0, errors));
  }, 0);
}

/**
 * Compare a maintainer benchmark result with an immutable machine-readable
 * baseline. This is intentionally not part of the production CLI: it is a
 * release/CI evidence gate and never turns missing evidence into a score.
 */
export function evaluateBenchmarkRegression(current, baseline, options = {}) {
  const runner = options.runner ?? 'default';
  const expected = selectBaseline(baseline, runner);
  const failures = [];
  const maxMetricDrop = finiteNumber(options.maxMetricDrop) ?? 0.01;
  const requireInputHash = options.requireInputHash ?? true;
  const requireEvaluatedCaseParity = options.requireEvaluatedCaseParity ?? true;
  const maxScanErrors = options.maxScanErrors;

  if (!expected || typeof expected !== 'object') {
    failures.push(`No regression baseline is defined for runner "${runner}".`);
    return { passed: false, runner, failures };
  }

  const currentManifest = current?.manifest;
  if (!currentManifest || typeof currentManifest !== 'object') {
    failures.push('Current benchmark result has no manifest metadata.');
  }

  const expectedManifestName = expected.manifestName ?? baseline?.manifestName;
  if (
    expectedManifestName &&
    currentManifest?.name !== undefined &&
    currentManifest.name !== expectedManifestName
  ) {
    failures.push(
      `Manifest name changed from "${expectedManifestName}" to "${currentManifest.name}".`,
    );
  }

  if (requireInputHash && expected.inputHash) {
    const actualHash = currentManifest?.inputHash;
    if (actualHash !== expected.inputHash) {
      failures.push(
        `Benchmark input hash changed from ${expected.inputHash} to ${actualHash ?? '(missing)'}; update the baseline only after reviewing corpus drift.`,
      );
    }
  }

  const expectedCases = finiteNumber(expected.evaluatedCases ?? expected.cases);
  const actualCases = finiteNumber(current?.evaluatedCases);
  if (expectedCases !== null && requireEvaluatedCaseParity && actualCases !== expectedCases) {
    failures.push(
      `Evaluated case count changed from ${expectedCases} to ${actualCases ?? '(missing)'}.`,
    );
  }

  if (maxScanErrors !== undefined) {
    const scanErrors = scanErrorCount(current);
    if (scanErrors > maxScanErrors) {
      failures.push(
        `Product scan errors ${scanErrors} exceed the allowed maximum ${maxScanErrors}.`,
      );
    }
  }

  const currentAggregate = current?.aggregate;
  const baselineAggregate = expected.aggregate;
  for (const metric of REGRESSION_METRICS) {
    const currentValue = finiteNumber(currentAggregate?.[metric]);
    const baselineValue = finiteNumber(baselineAggregate?.[metric]);
    if (currentValue === null || baselineValue === null) {
      failures.push(`Metric ${metric} is missing or non-finite in the regression result.`);
      continue;
    }
    if (currentValue < baselineValue - maxMetricDrop) {
      failures.push(
        `${metric} regressed from ${baselineValue.toFixed(6)} to ${currentValue.toFixed(6)} (allowed absolute drop ${maxMetricDrop.toFixed(6)}).`,
      );
    }
  }

  return {
    passed: failures.length === 0,
    runner,
    policy: {
      maxMetricDrop,
      requireInputHash,
      requireEvaluatedCaseParity,
      maxScanErrors: maxScanErrors ?? null,
    },
    baseline: {
      manifestName: expectedManifestName ?? null,
      inputHash: expected.inputHash ?? null,
      evaluatedCases: expectedCases,
      aggregate: baselineAggregate ?? null,
    },
    current: {
      manifestName: currentManifest?.name ?? null,
      inputHash: currentManifest?.inputHash ?? null,
      evaluatedCases: actualCases,
      aggregate: currentAggregate ?? null,
      scanErrors: scanErrorCount(current),
    },
    failures,
  };
}

export { REGRESSION_METRICS };
