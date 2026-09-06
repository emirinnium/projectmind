import { Command } from 'commander';
import { withService, asyncHandler, output, logger } from '@/cli/utils/shared.js';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  type SecretFinding,
  scanForSecrets,
  generateRotationSchedule,
  checkVaultIntegration,
  generateSarif,
  DEFAULT_POLICIES,
} from './secrets-life-engine.js';

export function createSecretsLifeCommand(): Command {
  const secretsCmd = new Command('secrets-life')
    .description('Secrets lifecycle management: detection, rotation, vault integration')
    .option('--scan', 'Scan for secrets in codebase')
    .option('--rotate', 'Show rotation schedule')
    .option('--vault', 'Check vault integration status')
    .option('--policy <file>', 'Custom rotation policy JSON file')
    .option('--entropy-threshold <n>', 'Minimum entropy for detection', '3.5')
    .option('--format <fmt>', 'Output: text|json|sarif', 'text')
    .option('-o, --output <file>', 'Write to file')
    .option('--max-files <n>', 'Max files to scan (0 = unlimited)', '0')
    .option('--max-findings <n>', 'Max findings to show (0 = unlimited)', '0')
    .action(
      asyncHandler(
        async (opts: {
          scan: boolean;
          rotate: boolean;
          vault: boolean;
          policy: string;
          entropyThreshold: string;
          format: string;
          output: string;
          maxFiles: string;
          maxFindings: string;
        }) => {
          await withService(['scale', 'coherence'], async (_ctx, services) => {
            const scale = services.scale!;
            services.coherence!;
            const { loadConfig } = await import('../../utils/config.js');
            const config = loadConfig();

            output.section('Secrets Lifecycle Manager');

            const policies = opts.policy
              ? JSON.parse(readFileSync(opts.policy, 'utf-8'))
              : DEFAULT_POLICIES;

            const entropyThreshold = parseFloat(opts.entropyThreshold);
            const maxFiles = parseInt(opts.maxFiles, 10);
            const maxFindings = parseInt(opts.maxFindings, 10);

            if (opts.scan) {
              output.section('Secret Scanning');

              const report = scale.getScaleReport();
              const allFiles = report.modules.flatMap((m) => m.files || []);
              const filesToScan = maxFiles > 0 ? allFiles.slice(0, maxFiles) : allFiles;

              if (filesToScan.length < allFiles.length) {
                output.warn(
                  `Scanning ${filesToScan.length} of ${allFiles.length} files. Use --max-files 0 to scan all.`,
                );
              }

              const findings: SecretFinding[] = [];

              for (const file of filesToScan) {
                try {
                  const content = readFileSync(file.path, 'utf-8');
                  const found = scanForSecrets(
                    content,
                    file.relativePath,
                    file.path,
                    entropyThreshold,
                  );
                  findings.push(...found);
                } catch (e) {
                  logger.warn(
                    `Skipping unreadable file in secrets scan: ${file.path} - ${e instanceof Error ? e.message : String(e)}`,
                  );
                }
              }

              if (findings.length === 0) {
                output.success('No secrets detected in codebase');
              } else {
                output.section(`Findings (${findings.length})`);

                const bySeverity = findings.reduce(
                  (acc, f) => {
                    acc[f.severity] = (acc[f.severity] || 0) + 1;
                    return acc;
                  },
                  {} as Record<string, number>,
                );

                for (const [sev, count] of Object.entries(bySeverity).sort()) {
                  const icon =
                    sev === 'critical'
                      ? '🔴'
                      : sev === 'high'
                        ? '🟠'
                        : sev === 'medium'
                          ? '🟡'
                          : '🟢';
                  output.kv(`${icon} ${sev.toUpperCase()}`, count);
                }

                if (opts.format === 'json' || opts.format === 'sarif') {
                  const sarif = generateSarif(findings);
                  const content =
                    opts.format === 'sarif'
                      ? JSON.stringify(sarif, null, 2)
                      : JSON.stringify({ findings }, null, 2);
                  if (opts.output) {
                    writeFileSync(opts.output, content);
                    output.success(`Written to ${opts.output}`);
                  } else {
                    output.raw(content);
                  }
                  return;
                }

                // Text format
                const findingsToShow = maxFindings > 0 ? findings.slice(0, maxFindings) : findings;
                for (const finding of findingsToShow) {
                  const icon =
                    finding.severity === 'critical'
                      ? '🔴'
                      : finding.severity === 'high'
                        ? '🟠'
                        : finding.severity === 'medium'
                          ? '🟡'
                          : '🟢';
                  output.kv(
                    `${icon} [${finding.type}] ${finding.file}:${finding.line}`,
                    finding.maskedValue,
                  );
                  if (finding.rotationDays !== undefined) {
                    output.kv(`   Rotation due in`, `${finding.rotationDays} days`);
                  }
                }

                if (opts.output) {
                  writeFileSync(opts.output, JSON.stringify({ findings }, null, 2));
                  output.success(`Written to ${opts.output}`);
                }
              }
            }

            if (opts.rotate) {
              output.section('Rotation Schedule');

              // Simulated rotation schedule based on findings
              const schedule = generateRotationSchedule(policies);

              output.section('Upcoming Rotations (next 30 days)');
              for (const item of schedule.slice(0, 15)) {
                const urgent =
                  item.daysUntilRotation <= 7 ? '🔴' : item.daysUntilRotation <= 14 ? '🟠' : '🟢';
                output.kv(
                  `${urgent} ${item.type}`,
                  `${item.name} - ${item.daysUntilRotation} days (${item.autoRotate ? 'auto' : 'manual'})`,
                );
              }

              if (opts.output) {
                writeFileSync(opts.output, JSON.stringify({ schedule }, null, 2));
                output.success(`Written to ${opts.output}`);
              }
            }

            if (opts.vault) {
              output.section('Vault Integration Status');

              // Check for vault configuration
              const vaultConfig = checkVaultIntegration(config);

              output.kv('Vault configured', vaultConfig.configured ? 'Yes' : 'No');
              output.kv('Address', vaultConfig.address || 'Not set');
              output.kv('Auth method', vaultConfig.authMethod || 'Not set');
              output.kv('Mount paths', vaultConfig.mountPaths?.join(', ') || 'Not configured');

              if (!vaultConfig.configured) {
                output.warn('Vault not configured. Run with --vault to see setup instructions.');
                output.info(
                  'To enable: Set VAULT_ADDR, VAULT_TOKEN, and configure mount paths in .projectmindrc.json',
                );
              }

              if (opts.output) {
                writeFileSync(opts.output, JSON.stringify(vaultConfig, null, 2));
                output.success(`Written to ${opts.output}`);
              }
            }

            if (!opts.scan && !opts.rotate && !opts.vault) {
              output.info('Use --scan, --rotate, or --vault to run specific checks');
            }
          });
        },
      ),
    );

  return secretsCmd;
}
