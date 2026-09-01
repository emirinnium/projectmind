import { Command } from 'commander';
import { withService, asyncHandler, output, logger } from '@/cli/utils/shared.js';
import { readFileSync } from 'node:fs';

export function createAuditCommand(): Command {
  return new Command('audit')
    .description('Security audit: secrets, crypto patterns, OWASP checks')
    .option('--secrets', 'Scan for secrets (API keys, tokens)')
    .option('--crypto', 'Check crypto usage')
    .option('--all', 'Run all checks')
    .option('-f, --format <fmt>', 'Output: text|json', 'text')
    .option('--max-files <n>', 'Max files to scan (0 = unlimited)', '0')
    .action(
      asyncHandler(
        async (opts: {
          secrets: boolean;
          crypto: boolean;
          all: boolean;
          format: string;
          maxFiles: string;
        }) => {
          await withService(['scale', 'coherence'], async (_ctx, services) => {
            const scale = services.scale!;
            const coherence = services.coherence!;

            output.section('Security Audit');

            const report = scale.getScaleReport();
            const files = report.modules.flatMap((m) => m.files || []);

            const maxFiles = parseInt(opts.maxFiles, 10);
            const filesToScan = maxFiles > 0 ? files.slice(0, maxFiles) : files;

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

            // Simple secret patterns
            const secretPatterns = [
              {
                regex: /(api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']+["']/gi,
                type: 'secret',
                severity: 'high',
              },
              {
                regex: /(aws[_-]?access[_-]?key|aws[_-]?secret[_-]?key)\s*[:=]\s*["'][^"']+["']/gi,
                type: 'aws-key',
                severity: 'critical',
              },
              {
                regex: /-----BEGIN (RSA|EC|DSA) PRIVATE KEY-----/g,
                type: 'private-key',
                severity: 'critical',
              },
              { regex: /eval\s*\(/g, type: 'eval', severity: 'high' },
              { regex: /new Function\s*\(/g, type: 'function-constructor', severity: 'high' },
              {
                regex: /crypto\.createCipher\(|crypto\.createDecipher\(/g,
                type: 'weak-crypto',
                severity: 'medium',
              },
              { regex: /md5|sha1/g, type: 'weak-hash', severity: 'medium' },
              {
                regex: /sha256/g,
                type: 'integrity-check',
                severity: 'low',
                message: 'Integrity check: prefer SHA-256 for new code',
              },
            ];

            for (const file of filesToScan) {
              try {
                const content = readFileSync(file.path, 'utf-8');
                const lines = content.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                  for (const pattern of secretPatterns) {
                    // Use match() instead of test() to avoid lastIndex state issues with /g flag
                    if (lines[i].match(pattern.regex)) {
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
                logger.debug(`Skipping file in audit: ${file.path}`);
              }
            }

            if (findings.length === 0) {
              output.success('No security issues found in scanned files');
            } else {
              if (opts.format === 'json') {
                console.log(
                  JSON.stringify({ findings, summary: { total: findings.length } }, null, 2),
                );
              } else {
                output.section(`Findings (${findings.length})`);
                for (const f of findings.slice(0, 50)) {
                  const icon =
                    f.severity === 'critical' ? '🔴' : f.severity === 'high' ? '🟠' : '🟡';
                  output.kv(`  ${icon} [${f.type}] ${f.file}:${f.line}`, f.message);
                }
              }
            }

            // Quick coherence check
            const check = await coherence.checkCoherence({
              code: '',
              filePath: 'audit',
              fastOnly: true,
            });
            output.kv('Coherence engine', check.verdict);
          });
        },
      ),
    );
}
