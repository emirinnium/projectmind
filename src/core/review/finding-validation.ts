import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertProjectPath } from '../security/path-security.js';
import { effectiveRules, type ReviewPolicy } from './policy.js';
import type { ReviewBundlePlan } from './bundle.js';
import { logger } from '../../utils/logger.js';
import { ruleMatchesSourceLine } from './rules.js';

export interface ReviewFindingLike {
  fingerprint: string;
  rule: string;
  severity: 'high' | 'medium' | 'low';
  file: string;
  line: number;
  message: string;
  confidence?: number;
  column?: number;
  endLine?: number;
}

export type FindingStatus =
  'verified' | 'unverifiable' | 'position-drift' | 'unsupported' | 'duplicate';

export interface ValidatedFinding extends ReviewFindingLike {
  status: FindingStatus;
  evidence?: { sourceHash: string; line: number; snippet: string };
  nextAction: string;
}

/** Validate path/line/source evidence independently from finding generation. */
export function validateFindingPositions(
  findings: readonly ReviewFindingLike[],
  bundlePlan: ReviewBundlePlan,
  projectRoot: string,
): ValidatedFinding[] {
  const bundled = new Set(
    bundlePlan.bundles.flatMap((bundle) => bundle.files.map((file) => file.relativePath)),
  );
  const bundleMetadata = new Map(
    bundlePlan.bundles.flatMap((bundle) =>
      bundle.files.map((file) => [file.relativePath, file] as const),
    ),
  );
  return findings.map((finding) => {
    if (!bundled.has(finding.file.replace(/\\/g, '/'))) {
      return {
        ...finding,
        status: 'unverifiable',
        nextAction:
          'Add the file to the deterministic review bundle before publishing this finding.',
      };
    }
    const allowedRanges = bundlePlan.allowedLineRanges?.[finding.file.replace(/\\/g, '/')];
    if (
      allowedRanges &&
      !allowedRanges.some(([start, end]) => finding.line >= start && finding.line <= end)
    ) {
      return {
        ...finding,
        status: 'position-drift',
        nextAction:
          'The finding is outside the changed-line ranges; move it to the changed line or quarantine it.',
      };
    }
    try {
      const absolutePath = assertProjectPath(finding.file, projectRoot, {
        mustExist: true,
        rejectIgnored: true,
      });
      const content = readFileSync(absolutePath, 'utf8');
      const lines = content.split(/\r?\n/);
      if (!Number.isInteger(finding.line) || finding.line < 1 || finding.line > lines.length) {
        return {
          ...finding,
          status: 'position-drift',
          nextAction:
            'Re-run review against the current source and locate the finding on a changed line.',
        };
      }
      const snippet = lines[finding.line - 1] ?? '';
      const expectedHash = bundleMetadata.get(finding.file.replace(/\\/g, '/'))?.sourceHash;
      const currentHash = createHash('sha256').update(content).digest('hex');
      if (expectedHash && expectedHash !== currentHash) {
        return {
          ...finding,
          status: 'unverifiable',
          nextAction:
            'The source changed after bundle creation; rebuild deterministic bundles and rerun review.',
        };
      }
      if (
        finding.column !== undefined &&
        (!Number.isInteger(finding.column) ||
          finding.column < 1 ||
          finding.column > snippet.length + 1)
      ) {
        return {
          ...finding,
          status: 'position-drift',
          nextAction: 'Move the finding column onto the cited source line and rerun reflection.',
        };
      }
      if (
        finding.endLine !== undefined &&
        (!Number.isInteger(finding.endLine) || finding.endLine < finding.line)
      ) {
        return {
          ...finding,
          status: 'position-drift',
          nextAction: 'Use an endLine at or after line and rerun position validation.',
        };
      }
      return {
        ...finding,
        status: 'verified',
        evidence: {
          sourceHash: currentHash,
          line: finding.line,
          snippet,
        },
        nextAction:
          'Source position is valid; review the evidence and remediation before applying changes.',
      };
    } catch (error) {
      logger.debug('Review finding position could not be read.', {
        file: finding.file,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ...finding,
        status: 'unverifiable',
        nextAction: 'Rescan the project and retry review for this file.',
      };
    }
  });
}

/** Independently reflect findings against the current source and policy. */
export function reflectFindings(
  findings: readonly ValidatedFinding[],
  policy: ReviewPolicy,
  _projectRoot: string,
): ValidatedFinding[] {
  const rules = new Map(effectiveRules(policy).map((rule) => [rule.id, rule]));
  const seen = new Set<string>();
  return findings.map((finding) => {
    if (seen.has(finding.fingerprint)) {
      return {
        ...finding,
        status: 'duplicate',
        nextAction: 'Keep the first occurrence and suppress this duplicate.',
      };
    }
    seen.add(finding.fingerprint);
    const rule = rules.get(finding.rule);
    if (!rule)
      return {
        ...finding,
        status: 'unsupported',
        nextAction:
          'Enable or define this rule in the review policy before publishing the finding.',
      };
    if (finding.status !== 'verified' || !finding.evidence) return finding;
    if (!ruleMatchesSourceLine(rule, finding.evidence.snippet)) {
      return {
        ...finding,
        status: 'unverifiable',
        nextAction: 'The source no longer supports this claim; discard it and rerun review.',
      };
    }
    const confidence = finding.confidence ?? rule.confidenceThreshold;
    if (confidence < rule.confidenceThreshold) {
      return {
        ...finding,
        status: 'unsupported',
        nextAction: `Increase confidence to at least ${rule.confidenceThreshold.toFixed(2)} or use the recall-first policy preset.`,
      };
    }
    return {
      ...finding,
      severity: rule.severity,
      message: rule.message,
      confidence,
      nextAction: 'Finding is independently source-backed and policy-valid.',
    };
  });
}

export function verifiedFindings(findings: readonly ValidatedFinding[]): ValidatedFinding[] {
  return findings.filter((finding) => finding.status === 'verified');
}
