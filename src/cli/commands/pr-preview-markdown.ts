import type { PrImpact } from './pr-preview-engine.js';

/** Render a review impact model as a stable, human-readable Markdown artifact. */
export function generateMarkdownPrPreview(impact: PrImpact): string {
  const lines = [
    '# PR Impact Preview',
    '',
    `**Base:** ${impact.baseRef} | **Head:** ${impact.headRef}`,
    `**Generated:** ${new Date().toISOString().split('T')[0]}`,
    '',
    '## Summary',
    `- **Changed Files:** ${impact.changedFiles.length}`,
    `- **Affected Modules:** ${impact.affectedModules.length}`,
    `- **Coherence Risk:** ${impact.coherenceRisk.toUpperCase()}`,
    `- **Suggested Tests:** ${impact.testSelection.length}`,
    `- **Breaking Changes:** ${impact.breakingChanges.length}`,
    `- **Deterministic Findings:** ${impact.findings.length}`,
    `- **Estimated Review Time:** ${impact.estimatedReviewTime} minutes`,
    '',
    '## Changed Files',
    '',
    ...impact.changedFiles.map((file) => `- \`${file}\``),
    '',
    '## Affected Modules',
    '',
    ...impact.affectedModules.map(
      (module) => `- **${module.path}** (${module.risk}): ${module.files.join(', ')}`,
    ),
    '',
    '## Coherence Issues',
    '',
    ...impact.coherenceIssues.map(
      (issue) =>
        `- **${issue.verdict.toUpperCase()}** \`${issue.file}\`: ${issue.issues.join('; ')}`,
    ),
    '',
    '## Breaking Changes',
    '',
    ...impact.breakingChanges.map((change) => `- ⚠️ ${change}`),
    '',
    '## Deterministic Review Findings',
    '',
    ...impact.findings.map(
      (finding) =>
        `- **${finding.severity.toUpperCase()}** [${finding.rule}] \`${finding.file}:${finding.line}\`: ${finding.message}`,
    ),
    '',
    '## Suggested Tests',
    '',
    ...impact.testSelection.map((test) => `- \`${test}\``),
    '',
    `## Estimated Review Time: ${impact.estimatedReviewTime} minutes`,
    '',
  ];

  return lines.join('\n');
}
