import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { assertProjectPath } from '../../dist/core/security/path-security.js';
import {
  isStaticAuditImplementation,
  scanStaticSecurityPatterns,
} from '../../dist/core/security/static-audit.js';
import { logger } from '../../dist/utils/logger.js';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
function isTestPath(filePath) {
  return (
    /(^|\/)(tests?|__tests__)(\/|$)/iu.test(filePath) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/iu.test(filePath)
  );
}
function collectSourceFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      try {
        const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
        const safePath = assertProjectPath(relativePath, root, {
          mustExist: true,
          rejectIgnored: true,
        });
        files.push({ path: relativePath, content: readFileSync(safePath, 'utf8') });
      } catch (error) {
        logger.debug('Security benchmark skipped unreadable source file.', {
          path: absolutePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
/**
 * Run the same static candidate rules as `pm audit` over a source tree.
 * This is an internal measurement API: counts are candidates, not
 * vulnerabilities, and test/spec files are excluded by default.
 */
export function runSecurityPatternBenchmark(projectRoot, options = {}) {
  const started = Date.now();
  const root = resolve(projectRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Security benchmark root is not a readable directory: ${projectRoot}`);
  }
  const sourceFiles = collectSourceFiles(root);
  const filesToScan = sourceFiles.filter(
    (file) =>
      !isStaticAuditImplementation(file.path) &&
      (options.includeTests === true || !isTestPath(file.path)),
  );
  const findings = [];
  for (const file of filesToScan) {
    findings.push(...scanStaticSecurityPatterns(file.content, file.path));
  }
  findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.type.localeCompare(right.type),
  );
  const bySeverity = { critical: 0, high: 0, medium: 0 };
  for (const finding of findings) bySeverity[finding.severity]++;
  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        files: filesToScan.map((file) => ({
          path: file.path,
          hash: createHash('sha256').update(file.content).digest('hex'),
        })),
        includeTests: options.includeTests ?? false,
      }),
    )
    .digest('hex');
  return {
    root,
    inputHash,
    filesScanned: filesToScan.length,
    filesSkipped: sourceFiles.length - filesToScan.length,
    findings,
    bySeverity,
    durationMs: Date.now() - started,
    limitations: [
      'Static signatures identify review candidates; they do not prove exploitability, reachability, secret validity or vulnerability severity.',
      'Dynamic code, generated files, runtime configuration and dependencies are not executed or resolved by this benchmark.',
      'Use the security CLI, taint analysis and source/runtime tests to validate a candidate before treating it as a defect.',
    ],
  };
}
/** Render security benchmark measurements without turning candidates into claims. */
export function renderSecurityBenchmarkMarkdown(result) {
  return [
    '# ProjectMind security pattern benchmark',
    '',
    `- Input hash: \`${result.inputHash}\``,
    `- Files scanned: ${result.filesScanned}`,
    `- Files skipped: ${result.filesSkipped}`,
    `- Candidate findings: ${result.findings.length}`,
    `- Duration: ${result.durationMs} ms`,
    '',
    '| Severity | Candidate count |',
    '| --- | ---: |',
    `| Critical | ${result.bySeverity.critical} |`,
    `| High | ${result.bySeverity.high} |`,
    `| Medium | ${result.bySeverity.medium} |`,
    '',
    '## Limitations',
    '',
    ...result.limitations.map((limitation) => `- ${limitation}`),
  ].join('\n');
}
