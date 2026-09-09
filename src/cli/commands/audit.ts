import { Command } from 'commander';
import { withService, asyncHandler, output, logger } from '@/cli/utils/shared.js';
import { readFileSync } from 'node:fs';

function isAuditImplementation(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    normalized === 'src/cli/commands/audit.ts' || normalized.endsWith('/src/cli/commands/audit.ts')
  );
}

export function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    /(^|\/)(tests?|__tests__)(\/|$)/i.test(normalized) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized)
  );
}

export function createAuditCommand(): Command {
  return new Command('audit')
    .description('Security audit: secrets, crypto patterns, OWASP checks')
    .option('--secrets', 'Scan for secrets (API keys, tokens)')
    .option('--crypto', 'Check crypto usage')
    .option('--all', 'Run all checks')
    .option('--include-tests', 'Include test and spec files in the audit')
    .option('-f, --format <fmt>', 'Output: text|json', 'text')
    .option('--max-files <n>', 'Max files to scan (0 = unlimited)', '0')
    .action(
      asyncHandler(
        async (opts: {
          secrets: boolean;
          crypto: boolean;
          all: boolean;
          includeTests: boolean;
          format: string;
          maxFiles: string;
        }) => {
          if (!['text', 'json'].includes(opts.format)) {
            throw new Error(`--format must be one of text or json: ${opts.format}`);
          }
          await withService(['scale', 'coherence'], async (_ctx, services) => {
            const scale = services.scale!;
            const coherence = services.coherence!;

            if (opts.format === 'text') output.section('Security Audit');

            const report = scale.getScaleReport();
            const files = report.modules.flatMap((m) => m.files || []);

            const maxFiles = parseInt(opts.maxFiles, 10);
            const filesToScan = maxFiles > 0 ? files.slice(0, maxFiles) : files;
            const includeTests = opts.includeTests === true;

            if (filesToScan.length < files.length) {
              output.warn(
                `Scanning ${filesToScan.length} of ${files.length} files. Use --max-files 0 to scan all.`,
              );
            }

            const findings: Array<{
              file: string;
              line: number;
              type: string;
              severity: string;
              message: string;
            }> = [];
            let filesScanned = 0;
            let filesSkipped = 0;

            // Simple secret patterns
            const secretPatterns = [
              {
                regex: /(api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']+["']/gi,
                type: 'secret',
                severity: 'high',
                category: 'secrets',
              },
              {
                regex: /(aws[_-]?access[_-]?key|aws[_-]?secret[_-]?key)\s*[:=]\s*["'][^"']+["']/gi,
                type: 'aws-key',
                severity: 'critical',
                category: 'secrets',
              },
              {
                regex: /-----BEGIN (RSA|EC|DSA) PRIVATE KEY-----/g,
                type: 'private-key',
                severity: 'critical',
                category: 'secrets',
              },
              { regex: /eval\s*\(/g, type: 'eval', severity: 'high', category: 'secrets' },
              {
                regex: /new Function\s*\(/g,
                type: 'function-constructor',
                severity: 'high',
                category: 'secrets',
              },
              {
                regex: /crypto\.createCipher\(|crypto\.createDecipher\(/g,
                type: 'weak-crypto',
                severity: 'medium',
                category: 'crypto',
              },
              { regex: /md5|sha1/g, type: 'weak-hash', severity: 'medium', category: 'crypto' },
            ];

            const runAll = opts.all || (!opts.secrets && !opts.crypto);
            const enabledCategories = new Set<string>([
              ...(runAll || opts.secrets ? ['secrets'] : []),
              ...(runAll || opts.crypto ? ['crypto'] : []),
            ]);

            for (const file of filesToScan) {
              // The audit rule definitions contain their own signatures (for
              // example /md5|sha1/), which are not application code. Scanning
              // this implementation would report those definitions as findings.
              if (isAuditImplementation(file.path) || (!includeTests && isTestFile(file.path))) {
                filesSkipped++;
                continue;
              }
              try {
                const content = readFileSync(file.path, 'utf-8');
                filesScanned++;
                const lines = content.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                  for (const pattern of secretPatterns) {
                    // Use match() instead of test() to avoid lastIndex state issues with /g flag
                    if (enabledCategories.has(pattern.category) && lines[i].match(pattern.regex)) {
                      findings.push({
                        file: file.path,
                        line: i + 1,
                        type: pattern.type,
                        severity: pattern.severity,
                        message: `Potential ${pattern.type} detected`,
                      });
                    }
                  }
                }
              } catch {
                // Skip files that can't be read (binary, permissions, etc.)
                filesSkipped++;
                logger.debug(`Skipping file in audit: ${file.path}`);
              }
            }

            const check = await coherence.checkCoherence({
              code: '',
              filePath: 'audit',
              fastOnly: true,
            });

            if (opts.format === 'json') {
              output.json({
                protocolVersion: 1,
                findings,
                summary: {
                  total: findings.length,
                  filesConsidered: filesToScan.length,
                  filesScanned,
                  filesSkipped,
                  includeTests,
                  coherence: check.verdict,
                },
              });
            } else {
              if (findings.length === 0) {
                output.success('No security issues found in scanned files');
              } else {
                output.section(`Findings (${findings.length})`);
                for (const f of findings.slice(0, 50)) {
                  const icon =
                    f.severity === 'critical' ? '🔴' : f.severity === 'high' ? '🟠' : '🟡';
                  output.kv(`  ${icon} [${f.type}] ${f.file}:${f.line}`, f.message);
                }
              }
              output.kv('Coherence engine', check.verdict);
            }
          });
        },
      ),
    );
}
