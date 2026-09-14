function countValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Compare static security candidate evidence with an immutable maintainer
 * baseline. Exact counts force rule changes to be reviewed explicitly; they
 * must never be interpreted as vulnerability severity or exploitability.
 */
export function evaluateSecurityRegression(current, baseline) {
  const failures = [];
  if (!current?.manifest || !baseline || typeof baseline !== 'object') {
    failures.push('Security regression result or baseline metadata is missing.');
    return { passed: false, failures };
  }

  if (baseline.manifestName && current.manifest.name !== baseline.manifestName) {
    failures.push(
      `Security manifest name changed from "${baseline.manifestName}" to "${current.manifest.name}".`,
    );
  }
  if (baseline.inputHash && current.manifest.inputHash !== baseline.inputHash) {
    failures.push(
      `Security corpus input hash changed from ${baseline.inputHash} to ${current.manifest.inputHash ?? '(missing)'}.`,
    );
  }

  for (const [label, expected, actual] of [
    ['verified repositories', baseline.verifiedRepositories, current.verifiedRepositories],
    ['files scanned', baseline.filesScanned, current.filesScanned],
    ['files skipped', baseline.filesSkipped, current.filesSkipped],
    ['candidate findings', baseline.candidateFindings, current.candidateFindings],
  ]) {
    const expectedValue = countValue(expected);
    const actualValue = countValue(actual);
    if (expectedValue === null || actualValue === null || expectedValue !== actualValue) {
      failures.push(
        `${label} changed from ${expectedValue ?? '(missing)'} to ${actualValue ?? '(missing)'}.`,
      );
    }
  }

  for (const severity of ['critical', 'high', 'medium']) {
    const expected = countValue(baseline.bySeverity?.[severity]);
    const actual = countValue(current.bySeverity?.[severity]);
    if (expected === null || actual === null || expected !== actual) {
      failures.push(
        `${severity} candidate count changed from ${expected ?? '(missing)'} to ${actual ?? '(missing)'}.`,
      );
    }
  }

  return {
    passed: failures.length === 0,
    baseline: {
      manifestName: baseline.manifestName ?? null,
      inputHash: baseline.inputHash ?? null,
      verifiedRepositories: baseline.verifiedRepositories ?? null,
      filesScanned: baseline.filesScanned ?? null,
      filesSkipped: baseline.filesSkipped ?? null,
      candidateFindings: baseline.candidateFindings ?? null,
      bySeverity: baseline.bySeverity ?? null,
    },
    current: {
      manifestName: current.manifest.name ?? null,
      inputHash: current.manifest.inputHash ?? null,
      verifiedRepositories: current.verifiedRepositories ?? null,
      filesScanned: current.filesScanned ?? null,
      filesSkipped: current.filesSkipped ?? null,
      candidateFindings: current.candidateFindings ?? null,
      bySeverity: current.bySeverity ?? null,
    },
    failures,
  };
}
