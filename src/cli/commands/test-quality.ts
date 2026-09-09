import { reportSuppressedError } from '../../utils/errors.js';
import { withService, asyncHandler, output, logger } from '@/cli/utils/shared.js';
import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { getStatement } from '../../storage/database.js';
import {
  type TestFile,
  analyzeTestFile,
  generateQualityReport,
  generateHtmlTestReport,
} from './test-quality-engine.js';

export function createTestQualityCommand(): Command {
  const testQualityCmd = new Command('test-quality')
    .description('Analyze test effectiveness: coverage, mutations, flakiness, weak assertions')
    .option('--mutation', 'Enable mutation testing analysis')
    .option('--framework <fw>', 'Test framework filter: vitest|jest|playwright|cypress|all', 'all')
    .option('--flaky-threshold <n>', 'Runs to consider flaky', '5')
    .option('--slow-threshold <ms>', 'Slow test threshold in ms', '1000')
    .option('--coverage-target <n>', 'Target coverage %', '80')
    .option('--format <fmt>', 'Output: text|json|html', 'text')
    .option('-o, --output <file>', 'Write to file')
    .action(
      asyncHandler(
        async (opts: {
          mutation: boolean;
          framework: string;
          flakyThreshold: string;
          slowThreshold: string;
          coverageTarget: string;
          format: string;
          output: string;
        }) => {
          await withService(['scale'], async (ctx, services) => {
            const scale = services.scale!;

            if (!['all', 'vitest', 'jest', 'playwright', 'cypress'].includes(opts.framework)) {
              throw new Error(`--framework is invalid: ${opts.framework}`);
            }
            if (!['text', 'json', 'html'].includes(opts.format)) {
              throw new Error(`--format must be text, json, or html: ${opts.format}`);
            }
            const coverageTarget = Number.parseInt(opts.coverageTarget, 10);
            const slowThreshold = Number.parseInt(opts.slowThreshold, 10);
            const flakyThreshold = Number.parseInt(opts.flakyThreshold, 10);
            if (!Number.isInteger(coverageTarget) || coverageTarget < 0 || coverageTarget > 100) {
              throw new Error(
                `--coverage-target must be between 0 and 100: ${opts.coverageTarget}`,
              );
            }
            if (!Number.isInteger(slowThreshold) || slowThreshold < 0) {
              throw new Error(
                `--slow-threshold must be a non-negative integer: ${opts.slowThreshold}`,
              );
            }
            if (!Number.isInteger(flakyThreshold) || flakyThreshold < 1) {
              throw new Error(
                `--flaky-threshold must be a positive integer: ${opts.flakyThreshold}`,
              );
            }
            if (opts.format === 'text') {
              output.section('Test Quality Analysis');
              output.kv('Mutation testing', opts.mutation ? 'enabled' : 'disabled');
              output.kv('Framework filter', opts.framework);
              output.kv('Coverage target', `${coverageTarget}%`);
            }

            const report = scale.getScaleReport();
            const allFiles = report.modules.flatMap((m) => m.files || []);

            // Find test files
            const testFiles = allFiles.filter(
              (f) =>
                f.relativePath.includes('.test.') ||
                f.relativePath.includes('.spec.') ||
                f.relativePath.startsWith('tests/'),
            );

            if (testFiles.length === 0) {
              if (opts.format === 'json') output.json({ testFiles: [], report: null });
              else output.warn('No test files found. Run "projectmind testgen" to generate tests.');
              return;
            }

            if (opts.format === 'text') output.kv('Test files found', testFiles.length);

            // Analyze each test file
            const testAnalysis: TestFile[] = [];
            const { readFileSync } = await import('node:fs');

            for (const file of testFiles.slice(0, 50)) {
              try {
                const content = readFileSync(file.path, 'utf-8');
                const analysis = analyzeTestFile(
                  content,
                  file.relativePath,
                  opts.framework,
                  ctx.config.projectRoot,
                );
                testAnalysis.push(analysis);
              } catch (e) {
                logger.warn(
                  `Skipping unreadable test file: ${file.path} - ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            }

            // Generate report
            const qualityReport = generateQualityReport(
              testAnalysis,
              coverageTarget,
              slowThreshold,
              flakyThreshold,
              ctx.config.projectRoot,
            );

            // Coverage trend: persist this run and diff against the previous one.
            try {
              getStatement(`CREATE TABLE IF NOT EXISTS coverage_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            avg_coverage REAL NOT NULL,
            total_tests INTEGER NOT NULL DEFAULT 0,
            total_assertions INTEGER NOT NULL DEFAULT 0
          )`).run();
              const prev = getStatement(
                'SELECT avg_coverage FROM coverage_snapshots ORDER BY id DESC LIMIT 1',
              ).get() as { avg_coverage: number } | undefined;
              getStatement(
                'INSERT INTO coverage_snapshots (avg_coverage, total_tests, total_assertions) VALUES (?, ?, ?)',
              ).run(
                qualityReport.avgCoverage,
                qualityReport.totalTests,
                qualityReport.totalAssertions,
              );
              if (prev && typeof prev.avg_coverage === 'number') {
                const delta = Math.round((qualityReport.avgCoverage - prev.avg_coverage) * 10) / 10;
                (
                  qualityReport as { coverageTrend?: { previous: number; delta: number } }
                ).coverageTrend = { previous: prev.avg_coverage, delta };
                if (opts.format === 'text') {
                  output.section('Coverage Trend');
                  output.kv('Previous run', `${prev.avg_coverage.toFixed(1)}%`);
                  output.kv(
                    'Delta',
                    `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% ${delta < 0 ? '📉 regression' : delta > 0 ? '📈 improvement' : '➖ flat'}`,
                  );
                  if (delta < -2) {
                    output.warn(
                      `Coverage regressed by ${Math.abs(delta).toFixed(1)}% since the last recorded run`,
                    );
                  }
                }
              }
            } catch (error) {
              reportSuppressedError(
                error,
                'Intentional fallback src/cli/commands/test-quality.ts:154',
              );
              // Snapshot persistence is best-effort; never block the report.
            }

            if (opts.format === 'json') {
              const content = JSON.stringify(
                { testFiles: testAnalysis, report: qualityReport },
                null,
                2,
              );
              if (opts.output) {
                writeFileSync(opts.output, content);
                output.success(`Written to ${opts.output}`);
              } else {
                output.raw(content);
              }
              return;
            }

            if (opts.format === 'html') {
              const content = generateHtmlTestReport(testAnalysis, qualityReport);
              if (opts.output) {
                writeFileSync(opts.output, content);
                output.success(`Written to ${opts.output}`);
              } else {
                output.raw(content);
              }
              return;
            }

            // Text format
            output.section(`Test File Analysis (${testAnalysis.length} files)`);

            // Summary
            output.kv('Total tests', qualityReport.totalTests);
            output.kv('Total assertions', qualityReport.totalAssertions);
            output.kv('Avg coverage', `${qualityReport.avgCoverage.toFixed(1)}%`);
            if (qualityReport.mutationScore !== undefined && qualityReport.mutationScore >= 0) {
              output.kv('Mutation score', `${qualityReport.mutationScore.toFixed(1)}%`);
            } else {
              output.info(
                'Mutation score unmeasured — no Stryker report artifact found (run "npx stryker run" to generate one)',
              );
            }
            output.kv('Skipped/todo tests', qualityReport.skippedTests);
            output.kv('Slow tests', qualityReport.slowTests.length);
            output.kv('Weak tests (low assertions)', qualityReport.weakTests.length);
            output.kv('Files below coverage target', qualityReport.missingCoverage.length);

            // Slow tests
            if (qualityReport.slowTests.length > 0) {
              output.section(`Slow Tests (>${opts.slowThreshold}ms)`);
              for (const test of qualityReport.slowTests.slice(0, 10)) {
                output.kv(
                  `  🐢 ${test.path}`,
                  `${test.duration}ms | ${test.tests} tests | ${test.assertions} assertions`,
                );
              }
            }

            // Weak tests
            if (qualityReport.weakTests.length > 0) {
              output.section(`Weak Tests (low assertion density)`);
              for (const test of qualityReport.weakTests.slice(0, 10)) {
                const density = test.tests > 0 ? (test.assertions / test.tests).toFixed(1) : '0';
                output.kv(
                  `  💪 ${test.path}`,
                  `${test.tests} tests, ${test.assertions} assertions (${density}/test)`,
                );
              }
            }

            // Missing coverage
            if (qualityReport.missingCoverage.length > 0) {
              output.section(`Files Below Coverage Target (${opts.coverageTarget}%)`);
              for (const item of qualityReport.missingCoverage.slice(0, 15)) {
                output.kv(
                  `  📉 ${item.file}`,
                  `Uncovered: ${item.uncoveredLines.slice(0, 5).join(', ')}${item.uncoveredLines.length > 5 ? '...' : ''}`,
                );
              }
            }

            // Skipped/todo tests (static stability signal)
            if (qualityReport.skippedTests > 0) {
              output.section(`Skipped/Todo Tests`);
              output.warn(
                `${qualityReport.skippedTests} skipped/todo tests detected — review, stabilize or remove`,
              );
            }

            // Recommendations
            if (qualityReport.recommendations.length > 0) {
              output.section('Recommendations');
              for (const rec of qualityReport.recommendations) {
                output.kv(`  💡 ${rec}`, '');
              }
            }

            if (opts.output) {
              const content = JSON.stringify(
                { testFiles: testAnalysis, report: qualityReport },
                null,
                2,
              );
              writeFileSync(opts.output, content);
              output.success(`Written to ${opts.output}`);
            }
          });
        },
      ),
    );

  return testQualityCmd;
}
