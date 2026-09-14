/**
 * Evaluate a release-facing corpus gate. Missing evidence fails explicitly;
 * it is never converted into a zero score or silently treated as a pass.
 */
export function evaluateBenchmarkGate(result, policy = {}) {
  const failures = [];
  const minimumEvaluatedCases = policy.minimumEvaluatedCases ?? 1;
  if (result.evaluatedCases < minimumEvaluatedCases) {
    failures.push(
      `Only ${result.evaluatedCases} benchmark case(s) were evaluated; at least ${minimumEvaluatedCases} are required.`,
    );
  }
  if (
    policy.minimumRecallAtK !== undefined &&
    result.aggregate.recallAtK < policy.minimumRecallAtK
  ) {
    failures.push(
      `Recall@k ${result.aggregate.recallAtK.toFixed(4)} is below ${policy.minimumRecallAtK.toFixed(4)}.`,
    );
  }
  if (policy.minimumF1 !== undefined && result.aggregate.f1 < policy.minimumF1) {
    failures.push(`F1 ${result.aggregate.f1.toFixed(4)} is below ${policy.minimumF1.toFixed(4)}.`);
  }
  if (policy.minimumMrr !== undefined && result.aggregate.mrr < policy.minimumMrr) {
    failures.push(
      `MRR ${result.aggregate.mrr.toFixed(4)} is below ${policy.minimumMrr.toFixed(4)}.`,
    );
  }
  if (
    policy.requireIndependentLabels &&
    result.manifest.independentlyVerifiedCases < result.manifest.cases
  ) {
    failures.push(
      `${result.manifest.pendingLabelCases} case(s) lack independent labels; public quality gating is blocked.`,
    );
  }
  if (policy.requireVerifiedCommits && result.repositories.some((item) => !item.commitVerified)) {
    failures.push('One or more repository checkouts are not verified at their manifest commit.');
  }
  return { passed: failures.length === 0, failures };
}
