import { Command } from 'commander';
import { withService, asyncHandler, output, logger } from '@/cli/utils/shared.js';
import { writeFileSync } from 'node:fs';
import { confineToProject } from '../../mcp/tools/_shared.js';
import {
  analyzeAffectedModules,
  buildReviewerConsensus,
  collectReviewFindings,
  detectBreakingChanges,
  estimateReviewTime,
  getChangedFiles,
  persistReviewHistory,
  selectTests,
  type PrImpact,
} from './pr-preview-engine.js';
import { generateMarkdownPrPreview } from './pr-preview-markdown.js';
import { generateSarifPrPreview } from './pr-preview-sarif.js';

export { validateGitRevision, type PrImpact } from './pr-preview-engine.js';
export { generateSarifPrPreview } from './pr-preview-sarif.js';

export function createPrPreviewCommand(): Command {
  const prCmd = new Command('pr-preview')
    .alias('review')
    .description(
      'Preview PR impact: changed files, affected modules, test selection, coherence risk',
    )
    .option('-b, --base <ref>', 'Base branch/ref', 'main')
    .option('-h, --head <ref>', 'Head branch/ref', 'HEAD')
    .option('--format <fmt>', 'Output: text|json|markdown|github|sarif', 'text')
    .option('-o, --output <file>', 'Write to file inside the project root')
    .option('--no-tests', 'Skip test selection')
    .option('--no-coherence', 'Skip coherence check')
    .option('--history', 'Persist findings and reconcile resolved findings')
    .action(
      asyncHandler(
        async (opts: {
          base: string;
          head: string;
          format: string;
          output: string;
          tests: boolean;
          coherence: boolean;
          history?: boolean;
        }) => {
          if (!['text', 'json', 'markdown', 'github', 'sarif'].includes(opts.format)) {
            throw new Error(
              `--format must be one of text, json, markdown, github, sarif: ${opts.format}`,
            );
          }
          const artifactFormat = ['json', 'markdown', 'github', 'sarif'].includes(opts.format);
          await withService(['scale', 'coherence'], async (_ctx, services) => {
            const scale = services.scale!;
            const coherence = services.coherence!;
            const { loadConfig } = await import('../../utils/config.js');
            const config = loadConfig();
            const outputPath = opts.output
              ? confineToProject(opts.output, config.projectRoot)
              : undefined;

            if (!artifactFormat) {
              output.section('PR Impact Preview');
              output.kv('Base', opts.base);
              output.kv('Head', opts.head);
            }

            const changedFiles = await getChangedFiles(opts.base, opts.head, config.projectRoot);

            if (changedFiles.length === 0) {
              const emptyImpact: PrImpact = {
                baseRef: opts.base,
                headRef: opts.head,
                changedFiles: [],
                affectedModules: [],
                coherenceRisk: 'low',
                testSelection: [],
                estimatedReviewTime: 10,
                breakingChanges: [],
                coherenceIssues: [],
                findings: [],
                reviewerConsensus: {
                  reviewers: [],
                  consolidatedFindingCount: 0,
                },
              };
              if (opts.history) {
                const history = persistReviewHistory(
                  _ctx.kg.getCurrentProjectId(),
                  opts.base,
                  opts.head,
                  changedFiles,
                  [],
                );
                if (artifactFormat)
                  process.stderr.write(
                    `Review history: ${history.open} open, ${history.resolved} resolved\n`,
                  );
                else {
                  output.kv('Review history', `${history.open} open, ${history.resolved} resolved`);
                }
              }
              if (artifactFormat) {
                let content: string;
                if (opts.format === 'json') content = JSON.stringify(emptyImpact, null, 2);
                else if (opts.format === 'sarif') content = generateSarifPrPreview(emptyImpact);
                else if (opts.format === 'markdown')
                  content = generateMarkdownPrPreview(emptyImpact);
                else {
                  content = [
                    '## 🧠 ProjectMind PR Analysis',
                    '',
                    generateMarkdownPrPreview(emptyImpact),
                  ].join('\n');
                }
                if (outputPath) {
                  writeFileSync(outputPath, content);
                  output.success(`Written to ${outputPath}`);
                } else {
                  process.stdout.write(`${content}\n`);
                }
              } else output.success('No changes detected.');
              return;
            }

            output.kv('Changed files', changedFiles.length);
            const affectedModules = analyzeAffectedModules(changedFiles, scale);
            let coherenceRisk: 'low' | 'medium' | 'high' = 'low';
            const coherenceIssues: PrImpact['coherenceIssues'] = [];

            if (opts.coherence) {
              output.info('Running coherence checks on changed files...');
              for (const file of changedFiles.slice(0, 20)) {
                try {
                  const { readFileSync } = await import('node:fs');
                  const content = readFileSync(confineToProject(file, config.projectRoot), 'utf-8');
                  const result = await coherence.checkCoherence({
                    code: content,
                    filePath: file,
                    fastOnly: true,
                  });
                  if (result.verdict !== 'pass') {
                    coherenceIssues.push({
                      file,
                      verdict: result.verdict,
                      issues: result.suggestions,
                    });
                  }
                } catch (e) {
                  logger.warn(
                    `Skipping unreadable file in PR preview: ${file} - ${e instanceof Error ? e.message : String(e)}`,
                  );
                }
              }
              const failCount = coherenceIssues.filter((i) => i.verdict === 'fail').length;
              const warnCount = coherenceIssues.filter((i) => i.verdict === 'warn').length;
              if (failCount > 0) coherenceRisk = 'high';
              else if (warnCount > 2) coherenceRisk = 'medium';
              else if (warnCount > 0) coherenceRisk = 'low';
            }

            const testSelection = opts.tests ? selectTests(changedFiles, scale) : [];
            const breakingChanges = detectBreakingChanges(changedFiles, scale);
            const findings = collectReviewFindings(changedFiles, config.projectRoot);
            const reviewerConsensus = buildReviewerConsensus(
              findings,
              coherenceIssues,
              breakingChanges,
            );
            const estimatedReviewTime = estimateReviewTime(
              changedFiles.length,
              coherenceRisk,
              testSelection.length,
            );
            const impact: PrImpact = {
              baseRef: opts.base,
              headRef: opts.head,
              changedFiles,
              affectedModules,
              coherenceRisk,
              testSelection,
              estimatedReviewTime,
              breakingChanges,
              coherenceIssues,
              findings,
              reviewerConsensus,
            };

            if (opts.history) {
              const history = persistReviewHistory(
                _ctx.kg.getCurrentProjectId(),
                opts.base,
                opts.head,
                changedFiles,
                findings,
              );
              output.kv('Review history', `${history.open} open, ${history.resolved} resolved`);
            }

            const render = (content: string, successMessage: string): void => {
              if (outputPath) {
                writeFileSync(outputPath, content);
                output.success(`${successMessage} ${outputPath}`);
              } else {
                process.stdout.write(`${content}\n`);
              }
            };
            if (opts.format === 'json') {
              render(JSON.stringify(impact, null, 2), 'Written to');
              return;
            }
            if (opts.format === 'markdown') {
              render(generateMarkdownPrPreview(impact), 'Written to');
              return;
            }
            if (opts.format === 'github') {
              const summary = [
                '## 🧠 ProjectMind PR Analysis',
                '',
                `<details><summary>Changed files: ${impact.changedFiles.length} — full report</summary>`,
                '',
                generateMarkdownPrPreview(impact),
                '',
                '</details>',
                '',
                `_Generated by ProjectMind · post with: gh pr comment <n> --body-file report.md_`,
                '',
              ].join('\n');
              render(summary, 'GitHub comment markdown written to');
              return;
            }
            if (opts.format === 'sarif') {
              render(generateSarifPrPreview(impact), 'SARIF written to');
              return;
            }

            output.section(`Changed Files (${changedFiles.length})`);
            for (const file of changedFiles.slice(0, 30)) output.kv(`  ${file}`, '');
            if (changedFiles.length > 30) {
              output.kv(`  ... and ${changedFiles.length - 30} more`, '');
            }
            output.section(`Affected Modules (${affectedModules.length})`);
            for (const mod of affectedModules) {
              output.kv(`  ${mod.path}`, `${mod.files.length} files | Risk: ${mod.risk}`);
            }
            output.section('Coherence Risk Assessment');
            const riskIcon =
              coherenceRisk === 'high' ? '🔴' : coherenceRisk === 'medium' ? '🟡' : '🟢';
            output.kv(`${riskIcon} Overall Risk`, coherenceRisk.toUpperCase());
            output.kv('Files with issues', coherenceIssues.length);
            output.kv('Deterministic findings', findings.length);
            output.kv(
              'Reviewer consensus',
              `${reviewerConsensus.consolidatedFindingCount} consolidated finding(s)`,
            );

            if (findings.length > 0) {
              output.section('Deterministic Review Findings');
              for (const finding of findings.slice(0, 30)) {
                output.kv(
                  `  [${finding.severity.toUpperCase()}] ${finding.file}:${finding.line}`,
                  `${finding.rule}: ${finding.message}`,
                );
              }
            }
            for (const issue of coherenceIssues.slice(0, 10)) {
              output.kv(
                `  ${issue.verdict === 'fail' ? '🔴' : '🟡'} ${issue.file}`,
                issue.issues.join('; '),
              );
            }
            if (opts.tests) {
              output.section(`Suggested Tests (${testSelection.length})`);
              for (const test of testSelection.slice(0, 15)) output.kv(`  🧪 ${test}`, '');
            }
            if (breakingChanges.length > 0) {
              output.section(`⚠️ Potential Breaking Changes (${breakingChanges.length})`);
              for (const change of breakingChanges) output.kv(`  ${change}`, '');
            }
            output.section('Estimated Review Time');
            output.kv('Time', `${estimatedReviewTime} minutes`);
            output.kv(
              'Basis',
              `${changedFiles.length} files, ${coherenceRisk} coherence risk, ${testSelection.length} tests`,
            );
            if (outputPath) {
              writeFileSync(outputPath, JSON.stringify(impact, null, 2));
              output.success(`Written to ${outputPath}`);
            }
          });
        },
      ),
    );

  return prCmd;
}
