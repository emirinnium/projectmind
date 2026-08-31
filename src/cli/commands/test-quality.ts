
import { withService, asyncHandler, output, logger } from '@/cli/utils/shared.js';
import { Command } from 'commander';

import { readFileSync, writeFileSync } from 'node:fs';

import { getStatement } from '../../storage/database.js';

interface TestFile {
  path: string;
  type: 'unit' | 'integration' | 'e2e' | 'component';
  framework: 'vitest' | 'jest' | 'mocha' | 'playwright' | 'cypress';
  tests: number;
  assertions: number;
  /** -1 = unmeasured (no coverage artifact); never fabricated */
  coverage: number;
  /** static stability signal: .skip/.todo/xit occurrences */
  skipped?: number;
  mutations?: { killed: number; total: number; score: number };
  flaky?: boolean;
  lastRun?: string;
  duration?: number;
}

interface TestQualityReport {
  totalFiles: number;
  totalTests: number;
  totalAssertions: number;
  avgCoverage: number;
  /** Real mutation score from a Stryker report artifact; -1 = unmeasured. */
  mutationScore?: number;
  /** Static stability signal: skipped/todo test count (true flakiness needs runtime reruns). */
  skippedTests: number;
  slowTests: TestFile[];
  weakTests: TestFile[];
  missingCoverage: { file: string; uncoveredLines: string[] }[];
  recommendations: string[];
}

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
    .action(asyncHandler(async (opts: { mutation: boolean; framework: string; flakyThreshold: string; slowThreshold: string; coverageTarget: string; format: string; output: string }) => {
      await withService(['scale', 'coherence'], async (_ctx, services) => {
        const scale = services.scale!;
        services.coherence!;
        
        output.section('Test Quality Analysis');
        output.kv('Mutation testing', opts.mutation ? 'enabled' : 'disabled');
        output.kv('Framework filter', opts.framework);
        output.kv('Coverage target', `${opts.coverageTarget}%`);
        
        const report = scale.getScaleReport();
        const allFiles = report.modules.flatMap(m => m.files || []);
        
        // Find test files
        const testFiles = allFiles.filter(f => 
          f.relativePath.includes('.test.') || 
          f.relativePath.includes('.spec.') ||
          f.relativePath.startsWith('tests/')
        );
        
        if (testFiles.length === 0) {
          output.warn('No test files found. Run "projectmind testgen" to generate tests.');
          return;
        }
        
        output.kv('Test files found', testFiles.length);
        
        // Analyze each test file
        const testAnalysis: TestFile[] = [];
        const { readFileSync } = await import('node:fs');
        
        for (const file of testFiles.slice(0, 50)) {
          try {
            const content = readFileSync(file.path, 'utf-8');
            const analysis = analyzeTestFile(content, file.relativePath, opts.framework);
            testAnalysis.push(analysis);
          } catch (e) {
            logger.warn(`Skipping unreadable test file: ${file.path} - ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        
        // Generate report
        const qualityReport = generateQualityReport(testAnalysis, parseInt(opts.coverageTarget, 10), parseInt(opts.slowThreshold, 10), parseInt(opts.flakyThreshold, 10));

        // Coverage trend: persist this run and diff against the previous one.
        try {
          getStatement(`CREATE TABLE IF NOT EXISTS coverage_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            avg_coverage REAL NOT NULL,
            total_tests INTEGER NOT NULL DEFAULT 0,
            total_assertions INTEGER NOT NULL DEFAULT 0
          )`).run();
          const prev = getStatement('SELECT avg_coverage FROM coverage_snapshots ORDER BY id DESC LIMIT 1').get() as { avg_coverage: number } | undefined;
          getStatement('INSERT INTO coverage_snapshots (avg_coverage, total_tests, total_assertions) VALUES (?, ?, ?)')
            .run(qualityReport.avgCoverage, qualityReport.totalTests, qualityReport.totalAssertions);
          if (prev && typeof prev.avg_coverage === 'number') {
            const delta = Math.round((qualityReport.avgCoverage - prev.avg_coverage) * 10) / 10;
            (qualityReport as { coverageTrend?: { previous: number; delta: number } }).coverageTrend = { previous: prev.avg_coverage, delta };
            output.section('Coverage Trend');
            output.kv('Previous run', `${prev.avg_coverage.toFixed(1)}%`);
            output.kv('Delta', `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% ${delta < 0 ? '📉 regression' : delta > 0 ? '📈 improvement' : '➖ flat'}`);
            if (delta < -2) {
              output.warn(`Coverage regressed by ${Math.abs(delta).toFixed(1)}% since the last recorded run`);
            }
          }
        } catch {
          // Snapshot persistence is best-effort; never block the report.
        }

        if (opts.format === 'json') {
          const content = JSON.stringify({ testFiles: testAnalysis, report: qualityReport }, null, 2);
          if (opts.output) {
            writeFileSync(opts.output, content);
            output.success(`Written to ${opts.output}`);
          } else {
            console.log(content);
          }
          return;
        }
        
        if (opts.format === 'html') {
          const content = generateHtmlTestReport(testAnalysis, qualityReport);
          if (opts.output) {
            writeFileSync(opts.output, content);
            output.success(`Written to ${opts.output}`);
          } else {
            console.log(content);
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
          output.info('Mutation score unmeasured — no Stryker report artifact found (run "npx stryker run" to generate one)');
        }
        output.kv('Skipped/todo tests', qualityReport.skippedTests);
        output.kv('Slow tests', qualityReport.slowTests.length);
        output.kv('Weak tests (low assertions)', qualityReport.weakTests.length);
        output.kv('Files below coverage target', qualityReport.missingCoverage.length);
        
        // Slow tests
        if (qualityReport.slowTests.length > 0) {
          output.section(`Slow Tests (>${opts.slowThreshold}ms)`);
          for (const test of qualityReport.slowTests.slice(0, 10)) {
            output.kv(`  🐢 ${test.path}`, `${test.duration}ms | ${test.tests} tests | ${test.assertions} assertions`);
          }
        }
        
        // Weak tests
        if (qualityReport.weakTests.length > 0) {
          output.section(`Weak Tests (low assertion density)`);
          for (const test of qualityReport.weakTests.slice(0, 10)) {
            const density = test.tests > 0 ? (test.assertions / test.tests).toFixed(1) : '0';
            output.kv(`  💪 ${test.path}`, `${test.tests} tests, ${test.assertions} assertions (${density}/test)`);
          }
        }
        
        // Missing coverage
        if (qualityReport.missingCoverage.length > 0) {
          output.section(`Files Below Coverage Target (${opts.coverageTarget}%)`);
          for (const item of qualityReport.missingCoverage.slice(0, 15)) {
            output.kv(`  📉 ${item.file}`, `Uncovered: ${item.uncoveredLines.slice(0, 5).join(', ')}${item.uncoveredLines.length > 5 ? '...' : ''}`);
          }
        }
        
        // Skipped/todo tests (static stability signal)
        if (qualityReport.skippedTests > 0) {
          output.section(`Skipped/Todo Tests`);
          output.warn(`${qualityReport.skippedTests} skipped/todo tests detected — review, stabilize or remove`);
        }
        
        // Recommendations
        if (qualityReport.recommendations.length > 0) {
          output.section('Recommendations');
          for (const rec of qualityReport.recommendations) {
            output.kv(`  💡 ${rec}`, '');
          }
        }
        
        if (opts.output) {
          const content = JSON.stringify({ testFiles: testAnalysis, report: qualityReport }, null, 2);
          writeFileSync(opts.output, content);
          output.success(`Written to ${opts.output}`);
        }
      });
    }));
  
  return testQualityCmd;
}

function analyzeTestFile(content: string, filePath: string, frameworkFilter: string): TestFile {
  // Detect framework
  let framework: TestFile['framework'] = 'vitest';
  if (content.includes('jest') || content.includes('@jest')) framework = 'jest';
  else if (content.includes('playwright')) framework = 'playwright';
  else if (content.includes('cypress')) framework = 'cypress';
  else if (content.includes('mocha')) framework = 'mocha';
  
  if (frameworkFilter !== 'all' && framework !== frameworkFilter) {
    return { path: filePath, type: 'unit', framework, tests: 0, assertions: 0, coverage: 0 };
  }
  
  // Count tests
  const testPatterns = [
    /(it|test)\s*\(\s*['"`]/g,           // vitest/jest
    /describe\s*\(\s*['"`]/g,            // describe blocks
    /it\s*\(\s*['"`]/g,                  // mocha
    /it\(['"`]/g,                        // playwright
  ];
  
  let tests = 0;
  for (const pattern of testPatterns) {
    tests += (content.match(pattern) || []).length;
  }
  
  // Count assertions
  const assertionPatterns = [
    /expect\s*\(/g,                      // vitest/jest
    /assert\s*\./g,                      // assert
    /should\s*\./g,                      // should.js
    /\.toBe\s*\(/g,                      // toBe
    /\.toEqual\s*\(/g,                   // toEqual
    /\.toContain\s*\(/g,                 // toContain
    /\.toHaveLength\s*\(/g,              // toHaveLength
  ];
  
  let assertions = 0;
  for (const pattern of assertionPatterns) {
    assertions += (content.match(pattern) || []).length;
  }
  
  // Detect test type
  let type: TestFile['type'] = 'unit';
  if (content.includes('e2e') || content.includes('playwright') || content.includes('cypress')) type = 'e2e';
  else if (content.includes('integration') || content.includes('.int.')) type = 'integration';
  else if (content.includes('component') || content.includes('.component.')) type = 'component';
  
  // Real coverage when the project has produced vitest/v8 summary data;
  // otherwise -1 signals 'unmeasured' (never fabricate).
  let coverage = -1;
  try {
    const summary = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf-8'));
    const total = summary.total?.statements?.pct ?? summary.total?.lines?.pct;
    if (typeof total === 'number') coverage = Math.max(0, Math.min(100, total));
  } catch { /* no coverage artifact */ }
  
  const skipped = (content.match(/\.(skip|todo)\s*\(|\bxit\s*\(/g) || []).length;

  return {
    path: filePath,
    type,
    framework,
    tests,
    assertions,
    coverage,
    skipped,
  };
}

function generateQualityReport(testFiles: TestFile[], coverageTarget: number, slowThreshold: number, _flakyThreshold: number): TestQualityReport {
  const totalTests = testFiles.reduce((sum, f) => sum + f.tests, 0);
  const totalAssertions = testFiles.reduce((sum, f) => sum + f.assertions, 0);
  const measured = testFiles.filter(f => f.coverage >= 0);
  const avgCoverage = measured.length > 0
    ? measured.reduce((sum, f) => sum + f.coverage, 0) / measured.length
    : 0;
  
  const slowTests = testFiles.filter(f => f.duration && f.duration > slowThreshold);
  const weakTests = testFiles.filter(f => f.tests > 0 && (f.assertions / f.tests) < 1.5);
  
  // Missing coverage
  const missingCoverage = testFiles
    .filter(f => f.coverage < coverageTarget)
    .filter(f => f.coverage >= 0)
    .map(f => ({ file: f.path, uncoveredLines: [] as string[] }));
  
  // Real static stability signal: skipped/todo tests (flakiness needs runtime data).
  const skippedTests = testFiles.reduce((sum, f) => sum + (f.skipped ?? 0), 0);
  
  const recommendations: string[] = [];
  
  if (testFiles.some(f => f.tests === 0)) {
    recommendations.push('Some test files have no tests - consider removing or adding tests');
  }
  
  if (weakTests.length > 0) {
    recommendations.push(`${weakTests.length} test files have low assertion density (<1.5 assertions/test) - add more specific assertions`);
  }
  
  if (slowTests.length > 0) {
    recommendations.push(`${slowTests.length} tests exceed ${slowThreshold}ms threshold - consider optimization`);
  }
  
  if (avgCoverage < coverageTarget) {
    recommendations.push(`Average coverage (${avgCoverage.toFixed(1)}%) below target (${coverageTarget}%) - add tests for uncovered code`);
  }
  
  if (missingCoverage.length > 0) {
    recommendations.push(`${missingCoverage.length} files below coverage target - prioritize adding tests for these`);
  }
  
  if (skippedTests > 0) {
    recommendations.push(`${skippedTests} skipped/todo tests detected - review and stabilize or remove`);
  }

  // Real mutation score when a Stryker report artifact exists; otherwise -1.
  const mutationScore = readStrykerMutationScore();

  return {
    totalFiles: testFiles.length,
    totalTests,
    totalAssertions,
    avgCoverage,
    mutationScore,
    skippedTests,
    slowTests,
    weakTests,
    missingCoverage,
    recommendations,
  };
}

/**
 * Read the real mutation score from a Stryker JSON report when present.
 * Mutation testing cannot be derived statically — without an artifact this
 * returns -1 ('unmeasured'), never a fabricated number.
 */
function readStrykerMutationScore(): number {
  const candidates = [
    'reports/mutation/mutation.json',
    'reports/mutation.json',
    'reports/evaluation/mutation.json',
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(readFileSync(candidate, 'utf-8')) as unknown;
      const score = extractStrykerScore(raw);
      if (score !== null) return Math.max(0, Math.min(100, score));
    } catch {
      /* artifact not present / unreadable at this location */
    }
  }
  return -1;
}

function extractStrykerScore(raw: unknown): number | null {
  interface MutantLike { status?: string }
  interface ReportLike {
    files?: Record<string, { mutants?: MutantLike[] }>;
    scores?: { mutationScore?: number };
    metrics?: { mutationScore?: number };
  }
  const obj = raw as ReportLike;

  if (typeof obj?.scores?.mutationScore === 'number') {
    return obj.scores.mutationScore <= 1 ? obj.scores.mutationScore * 100 : obj.scores.mutationScore;
  }
  if (typeof obj?.metrics?.mutationScore === 'number') {
    return obj.metrics.mutationScore <= 1 ? obj.metrics.mutationScore * 100 : obj.metrics.mutationScore;
  }

  // Standard Stryker JSON-API report: per-file mutant lists.
  if (obj?.files && typeof obj.files === 'object') {
    let detected = 0;
    let total = 0;
    for (const file of Object.values(obj.files)) {
      if (!file || !Array.isArray(file.mutants)) continue;
      for (const mutant of file.mutants) {
        total++;
        if (mutant.status === 'Killed' || mutant.status === 'Timeout') detected++;
      }
    }
    if (total > 0) return (detected / total) * 100;
  }
  return null;
}

function generateHtmlTestReport(testFiles: TestFile[], report: TestQualityReport): string {
  const rows = testFiles.map(f => `
    <tr>
      <td>${f.path}</td>
      <td>${f.type}</td>
      <td>${f.framework}</td>
      <td>${f.tests}</td>
      <td>${f.assertions}</td>
      <td>${f.assertions / Math.max(f.tests, 1)}</td>
      <td>${f.coverage.toFixed(1)}%</td>
      <td>${f.duration ? f.duration + 'ms' : 'N/A'}</td>
    </tr>
  `).join('');
  
  return `<!DOCTYPE html>
<html>
<head>
  <title>Test Quality Report</title>
  <style>
    body { font-family: system-ui; max-width: 1400px; margin: 2rem auto; padding: 1rem; }
    .stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1rem; margin: 1rem 0; }
    .stat { padding: 1rem; background: #f5f5f5; border-radius: 4px; text-align: center; }
    .stat .value { font-size: 2rem; font-weight: bold; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; }
    th { background: #f5f5f5; position: sticky; top: 0; }
    .weak { background: #fff3e0; }
    .slow { background: #ffebee; }
    .low-coverage { background: #fce4ec; }
  </style>
</head>
<body>
  <h1>Test Quality Report</h1>
  <div class="stats">
    <div class="stat"><div class="value">${report.totalTests}</div><div class="label">Total Tests</div></div>
    <div class="stat"><div class="value">${report.totalAssertions}</div><div class="label">Total Assertions</div></div>
    <div class="stat"><div class="value">${report.avgCoverage.toFixed(1)}%</div><div class="label">Avg Coverage</div></div>
    <div class="stat"><div class="value">${report.mutationScore?.toFixed(1) || 'N/A'}%</div><div class="label">Mutation Score</div></div>
    <div class="stat"><div class="value">${report.skippedTests}</div><div class="label">Skipped/Todo Tests</div></div>
  </div>
  <h2>Test Files</h2>
  <table>
    <thead><tr><th>File</th><th>Type</th><th>Framework</th><th>Tests</th><th>Assertions</th><th>Assertions/Test</th><th>Coverage</th><th>Duration</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <h2>Recommendations</h2>
  <ul>${report.recommendations.map(r => `<li>${r}</li>`).join('')}</ul>
</body>
</html>`;
}