import { Command } from 'commander';
import { withService, asyncHandler, output, logger, loadConfig } from '@/cli/utils/shared.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { confineToProject } from '@/mcp/tools/_shared.js';
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
    .description('Secret detection, rotation planning, and optional Vault configuration checks')
    .option('--scan', 'Scan for secrets in codebase')
    .option('--rotate', 'Show a rotation plan; this does not mutate secrets')
    .option('--vault', 'Check Vault configuration; no Vault API calls are made')
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
          await withService(['scale'], async (_ctx, services) => {
            const scale = services.scale!;
            const config = loadConfig();

            if (!['text', 'json', 'sarif'].includes(opts.format)) {
              throw new Error(`--format must be text, json, or sarif: ${opts.format}`);
            }
            const entropyThreshold = Number.parseFloat(opts.entropyThreshold);
            const maxFiles = Number.parseInt(opts.maxFiles, 10);
            const maxFindings = Number.parseInt(opts.maxFindings, 10);
            if (
              !Number.isFinite(entropyThreshold) ||
              entropyThreshold < 0 ||
              entropyThreshold > 20
            ) {
              throw new Error(
                `--entropy-threshold must be a number between 0 and 20: ${opts.entropyThreshold}`,
              );
            }
            if (!Number.isSafeInteger(maxFiles) || maxFiles < 0 || maxFiles > 100_000) {
              throw new Error(
                `--max-files must be an integer between 0 and 100000: ${opts.maxFiles}`,
              );
            }
            if (!Number.isSafeInteger(maxFindings) || maxFindings < 0 || maxFindings > 100_000) {
              throw new Error(
                `--max-findings must be an integer between 0 and 100000: ${opts.maxFindings}`,
              );
            }
            const outputPath = opts.output
              ? confineToProject(opts.output, config.projectRoot)
              : undefined;

            output.section('Secrets Lifecycle Manager');

            const policyPath = opts.policy
              ? confineToProject(opts.policy, config.projectRoot)
              : undefined;
            const policies = policyPath
              ? JSON.parse(readFileSync(policyPath, 'utf-8'))
              : DEFAULT_POLICIES;

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
                  const found = scanForSecrets(content, file.relativePath, entropyThreshold);
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
                  if (outputPath) {
                    writeFileSync(outputPath, content);
                    output.success(`Written to ${outputPath}`);
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

                if (outputPath) {
                  writeFileSync(outputPath, JSON.stringify({ findings }, null, 2));
                  output.success(`Written to ${outputPath}`);
                }
              }
            }

            if (opts.rotate) {
              output.section('Rotation Plan (no secret mutation)');

              // This command intentionally plans rotation; it never writes or
              // changes a secret value.
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

              if (outputPath) {
                writeFileSync(outputPath, JSON.stringify({ schedule }, null, 2));
                output.success(`Written to ${outputPath}`);
              }
            }

            if (opts.vault) {
              output.section('Vault Configuration Status');

              // Check for vault configuration
              const vaultConfig = checkVaultIntegration(config);

              output.kv('Vault configured', vaultConfig.configured ? 'Yes' : 'No');
              output.kv('Address', vaultConfig.address || 'Not set');
              output.kv('Auth method', vaultConfig.authMethod || 'Not set');
              output.kv('Mount paths', vaultConfig.mountPaths?.join(', ') || 'Not configured');

              if (!vaultConfig.configured) {
                output.warn('Vault is not configured; no Vault API operation was attempted.');
                output.info(
                  'To enable: Set VAULT_ADDR, VAULT_TOKEN, and configure mount paths in .projectmindrc.json',
                );
              }

              if (outputPath) {
                writeFileSync(outputPath, JSON.stringify(vaultConfig, null, 2));
                output.success(`Written to ${outputPath}`);
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
