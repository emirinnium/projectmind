import { reportSuppressedError } from '../../utils/errors.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TestFile {
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

export interface TestQualityReport {
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

export function analyzeTestFile(
  content: string,
  filePath: string,
  frameworkFilter: string,
  projectRoot = process.cwd(),
): TestFile {
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
  const testPatterns = [/\b(?:it|test)(?:\.(?:skip|only|todo))?\s*\(\s*['"`]/g];

  let tests = 0;
  for (const pattern of testPatterns) {
    tests += (content.match(pattern) || []).length;
  }

  // Count assertions
  const assertionPatterns = [
    /expect\s*\(/g, // vitest/jest
    /assert\s*\./g, // assert
    /should\s*\./g, // should.js
  ];

  let assertions = 0;
  for (const pattern of assertionPatterns) {
    assertions += (content.match(pattern) || []).length;
  }

  // Detect test type
  let type: TestFile['type'] = 'unit';
  if (content.includes('e2e') || content.includes('playwright') || content.includes('cypress'))
    type = 'e2e';
  else if (content.includes('integration') || content.includes('.int.')) type = 'integration';
  else if (content.includes('component') || content.includes('.component.')) type = 'component';

  // Real coverage when the project has produced vitest/v8 summary data;
  // otherwise -1 signals 'unmeasured' (never fabricate).
  let coverage = -1;
  try {
    const summary = JSON.parse(
      readFileSync(join(projectRoot, 'coverage', 'coverage-summary.json'), 'utf-8'),
    );
    const total = summary.total?.statements?.pct ?? summary.total?.lines?.pct;
    if (typeof total === 'number') coverage = Math.max(0, Math.min(100, total));
  } catch (error) {
    reportSuppressedError(error, 'Intentional fallback src/cli/commands/test-quality-engine.ts:88');
    /* no coverage artifact */
  }

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

export function generateQualityReport(
  testFiles: TestFile[],
  coverageTarget: number,
  slowThreshold: number,
  _flakyThreshold: number,
  projectRoot = process.cwd(),
): TestQualityReport {
  const totalTests = testFiles.reduce((sum, f) => sum + f.tests, 0);
  const totalAssertions = testFiles.reduce((sum, f) => sum + f.assertions, 0);
  const measured = testFiles.filter((f) => f.coverage >= 0);
  const avgCoverage =
    measured.length > 0 ? measured.reduce((sum, f) => sum + f.coverage, 0) / measured.length : 0;

  const slowTests = testFiles.filter((f) => f.duration && f.duration > slowThreshold);
  const weakTests = testFiles.filter((f) => f.tests > 0 && f.assertions / f.tests < 1.5);

  // Missing coverage
  const missingCoverage = testFiles
    .filter((f) => f.coverage < coverageTarget)
    .filter((f) => f.coverage >= 0)
    .map((f) => ({ file: f.path, uncoveredLines: [] as string[] }));

  // Real static stability signal: skipped/todo tests (flakiness needs runtime data).
  const skippedTests = testFiles.reduce((sum, f) => sum + (f.skipped ?? 0), 0);

  const recommendations: string[] = [];

  if (testFiles.some((f) => f.tests === 0)) {
    recommendations.push('Some test files have no tests - consider removing or adding tests');
  }

  if (weakTests.length > 0) {
    recommendations.push(
      `${weakTests.length} test files have low assertion density (<1.5 assertions/test) - add more specific assertions`,
    );
  }

  if (slowTests.length > 0) {
    recommendations.push(
      `${slowTests.length} tests exceed ${slowThreshold}ms threshold - consider optimization`,
    );
  }

  if (avgCoverage < coverageTarget) {
    recommendations.push(
      `Average coverage (${avgCoverage.toFixed(1)}%) below target (${coverageTarget}%) - add tests for uncovered code`,
    );
  }

  if (missingCoverage.length > 0) {
    recommendations.push(
      `${missingCoverage.length} files below coverage target - prioritize adding tests for these`,
    );
  }

  if (skippedTests > 0) {
    recommendations.push(
      `${skippedTests} skipped/todo tests detected - review and stabilize or remove`,
    );
  }

  // Real mutation score when a Stryker report artifact exists; otherwise -1.
  const mutationScore = readStrykerMutationScore(projectRoot);

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
function readStrykerMutationScore(projectRoot: string): number {
  const candidates = [
    join(projectRoot, 'reports', 'mutation', 'mutation.json'),
    join(projectRoot, 'reports', 'mutation.json'),
    join(projectRoot, 'reports', 'evaluation', 'mutation.json'),
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(readFileSync(candidate, 'utf-8')) as unknown;
      const score = extractStrykerScore(raw);
      if (score !== null) return Math.max(0, Math.min(100, score));
    } catch (error) {
      reportSuppressedError(
        error,
        'Intentional fallback src/cli/commands/test-quality-engine.ts:199',
      );
      /* artifact not present / unreadable at this location */
    }
  }
  return -1;
}

function extractStrykerScore(raw: unknown): number | null {
  interface MutantLike {
    status?: string;
  }
  interface ReportLike {
    files?: Record<string, { mutants?: MutantLike[] }>;
    scores?: { mutationScore?: number };
    metrics?: { mutationScore?: number };
  }
  const obj = raw as ReportLike;

  if (typeof obj?.scores?.mutationScore === 'number') {
    return obj.scores.mutationScore <= 1
      ? obj.scores.mutationScore * 100
      : obj.scores.mutationScore;
  }
  if (typeof obj?.metrics?.mutationScore === 'number') {
    return obj.metrics.mutationScore <= 1
      ? obj.metrics.mutationScore * 100
      : obj.metrics.mutationScore;
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

export function generateHtmlTestReport(testFiles: TestFile[], report: TestQualityReport): string {
  const rows = testFiles
    .map(
      (f) => `
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
  `,
    )
    .join('');

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
  <ul>${report.recommendations.map((r) => `<li>${r}</li>`).join('')}</ul>
</body>
</html>`;
}
