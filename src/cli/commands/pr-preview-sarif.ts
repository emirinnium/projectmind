import type { PrImpact } from './pr-preview-engine.js';
import { currentModuleDir, resolvePackageVersion } from '@/cli/utils/version.js';

const packageVersion = resolvePackageVersion(currentModuleDir(import.meta.url));

type SarifLevel = 'error' | 'warning' | 'note';

interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations?: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region?: { startLine: number };
    };
  }>;
  partialFingerprints: { primaryLocationLineHash: string };
}

function levelFor(severity: 'high' | 'medium' | 'low'): SarifLevel {
  if (severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'note';
}

/**
 * Produce SARIF 2.1.0 for CI code-scanning consumers. Every result keeps a
 * stable rule id, file location (when available), and finding fingerprint so
 * GitHub/code-scanning can track the same issue across runs.
 */
export function generateSarifPrPreview(impact: PrImpact): string {
  const results: SarifResult[] = impact.findings.map((finding) => ({
    ruleId: finding.rule,
    level: levelFor(finding.severity),
    message: { text: finding.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: finding.file.replace(/\\/g, '/') },
          region: { startLine: Math.max(1, finding.line) },
        },
      },
    ],
    partialFingerprints: { primaryLocationLineHash: finding.fingerprint },
  }));

  for (const issue of impact.coherenceIssues) {
    results.push({
      ruleId: `coherence-${issue.verdict}`,
      level: issue.verdict === 'fail' ? 'error' : 'warning',
      message: { text: issue.issues.join('; ') || 'Coherence check returned a non-pass verdict.' },
      locations: [
        { physicalLocation: { artifactLocation: { uri: issue.file.replace(/\\/g, '/') } } },
      ],
      partialFingerprints: {
        primaryLocationLineHash: `coherence:${issue.file}:${issue.verdict}`,
      },
    });
  }

  for (const [index, change] of impact.breakingChanges.entries()) {
    results.push({
      ruleId: 'potential-breaking-change',
      level: 'warning',
      message: { text: change },
      partialFingerprints: { primaryLocationLineHash: `breaking:${index}:${change}` },
    });
  }

  const ruleIds = [...new Set(results.map((result) => result.ruleId))].sort();
  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'ProjectMind',
              version: packageVersion,
              informationUri: 'https://github.com/emirinnium/projectmind',
              rules: ruleIds.map((id) => ({ id })),
            },
          },
          invocations: [{ executionSuccessful: true }],
          results,
          properties: {
            baseRef: impact.baseRef,
            headRef: impact.headRef,
            changedFileCount: impact.changedFiles.length,
            coherenceRisk: impact.coherenceRisk,
          },
        },
      ],
    },
    null,
    2,
  );
}
