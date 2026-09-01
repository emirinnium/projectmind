import { Command } from 'commander';
import { withService, asyncHandler, output, logger } from '@/cli/utils/shared.js';
import { readFileSync, writeFileSync } from 'node:fs';
import type { ProjectMindConfig } from '@/utils/config.js';

interface SecretFinding {
  type:
    | 'api-key'
    | 'aws-key'
    | 'private-key'
    | 'password'
    | 'token'
    | 'secret'
    | 'connection-string'
    | 'jwt'
    | 'certificate';
  file: string;
  line: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  maskedValue: string;
  entropy?: number;
  rotationDays?: number;
  lastRotated?: string;
  vaultManaged?: boolean;
}

interface RotationPolicy {
  type: string;
  maxAgeDays: number;
  autoRotate: boolean;
  vaultPath?: string;
}

const DEFAULT_POLICIES: Record<string, RotationPolicy> = {
  'api-key': { type: 'api-key', maxAgeDays: 90, autoRotate: false },
  'aws-key': { type: 'aws-key', maxAgeDays: 90, autoRotate: true, vaultPath: 'aws/' },
  'private-key': { type: 'private-key', maxAgeDays: 365, autoRotate: false },
  password: { type: 'password', maxAgeDays: 90, autoRotate: true },
  token: { type: 'token', maxAgeDays: 30, autoRotate: true },
  secret: { type: 'secret', maxAgeDays: 60, autoRotate: false },
  'connection-string': { type: 'connection-string', maxAgeDays: 90, autoRotate: true },
  jwt: { type: 'jwt', maxAgeDays: 30, autoRotate: true },
  certificate: { type: 'certificate', maxAgeDays: 365, autoRotate: false },
};

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
                    console.log(content);
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

function scanForSecrets(
  content: string,
  relativePath: string,
  filePath: string,
  entropyThreshold: number,
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split(/\r?\n/);

  // Secret patterns with entropy calculation
  const patterns = [
    {
      regex: /(?:api[_-]?key|apikey)\s*[:=]\s*["']([^"']{20,})["']/gi,
      type: 'api-key' as const,
      severity: 'high' as const,
    },
    {
      regex: /(?:aws[_-]?access[_-]?key|aws[_-]?secret[_-]?key)\s*[:=]\s*["']([^"']+)["']/gi,
      type: 'aws-key' as const,
      severity: 'critical' as const,
    },
    {
      regex: /(?:secret|secret[_-]?key)\s*[:=]\s*["']([^"']{20,})["']/gi,
      type: 'secret' as const,
      severity: 'high' as const,
    },
    {
      regex: /(?:password|passwd|pwd)\s*[:=]\s*["']([^"']{8,})["']/gi,
      type: 'password' as const,
      severity: 'high' as const,
    },
    {
      regex: /(?:token|access[_-]?token|bearer[_-]?token)\s*[:=]\s*["']([^"']{20,})["']/gi,
      type: 'token' as const,
      severity: 'high' as const,
    },
    {
      regex: /-----BEGIN (?:RSA|EC|DSA|OPENSSH) PRIVATE KEY-----/g,
      type: 'private-key' as const,
      severity: 'critical' as const,
    },
    {
      regex: /(?:connection[_-]?string|conn[_-]?str)\s*[:=]\s*["']([^"']+)["']/gi,
      type: 'connection-string' as const,
      severity: 'high' as const,
    },
    {
      regex: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
      type: 'jwt' as const,
      severity: 'high' as const,
    },
    {
      regex: /-----BEGIN CERTIFICATE-----/g,
      type: 'certificate' as const,
      severity: 'medium' as const,
    },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { regex, type, severity } of patterns) {
      let match;
      while ((match = regex.exec(line)) !== null) {
        const value = match[1] || match[0];
        const entropy = calculateEntropy(value);

        if (entropy >= entropyThreshold) {
          findings.push({
            type,
            file: relativePath,
            line: i + 1,
            severity,
            maskedValue: maskValue(value),
            entropy,
            rotationDays: getRotationPolicy(type),
            lastRotated: 'unknown', // Would require vault integration for real data
            vaultManaged: false,
          });
        }
      }
    }
  }

  return findings;
}

function calculateEntropy(str: string): number {
  if (!str || str.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const char of str) {
    freq.set(char, (freq.get(char) || 0) + 1);
  }
  let entropy = 0;
  const len = str.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function maskValue(value: string): string {
  if (value.length <= 8) return '***';
  return value.substring(0, 4) + '*'.repeat(value.length - 8) + value.substring(value.length - 4);
}

/**
 * Get rotation days based on secret type (industry best practices).
 */
function getRotationPolicy(type: string): number {
  const policies: Record<string, number> = {
    'api-key': 90,
    'aws-key': 90,
    'private-key': 365,
    password: 90,
    token: 30,
    secret: 90,
    'connection-string': 90,
    jwt: 30,
    certificate: 365,
  };
  return policies[type] ?? 90; // Default: 90 days
}

function generateRotationSchedule(
  policies: Record<string, RotationPolicy>,
): { type: string; name: string; daysUntilRotation: number; autoRotate: boolean }[] {
  const schedule = [];
  const types = [
    'api-key',
    'aws-key',
    'private-key',
    'password',
    'token',
    'secret',
    'connection-string',
    'jwt',
    'certificate',
  ];

  for (const type of types) {
    const policy = policies[type];
    if (policy) {
      schedule.push({
        type,
        name: `${type}-policy`,
        daysUntilRotation: policy.maxAgeDays,
        autoRotate: policy.autoRotate,
      });
    }
  }

  return schedule.sort((a, b) => a.daysUntilRotation - b.daysUntilRotation);
}

function checkVaultIntegration(config: ProjectMindConfig & { vault?: { mountPaths?: string[] } }): {
  configured: boolean;
  address?: string;
  authMethod?: string;
  mountPaths?: string[];
} {
  // Check for vault configuration in environment or config
  const vaultAddr = process.env.VAULT_ADDR;
  const vaultToken = process.env.VAULT_TOKEN;

  return {
    configured: !!(vaultAddr && vaultToken),
    address: vaultAddr,
    authMethod: vaultToken ? 'token' : undefined,
    mountPaths: config.vault?.mountPaths || ['secret/', 'kv/'],
  };
}

interface SarifReport {
  version: string;
  $schema: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        version: string;
        rules: Array<{ id: string }>;
      };
    };
    results: Array<{
      ruleId: string;
      level: string;
      message: { text: string };
      locations: Array<{
        physicalLocation: {
          artifactLocation: { uri: string };
          region: { startLine: number };
        };
      }>;
    }>;
  }>;
}

function generateSarif(findings: SecretFinding[]): SarifReport {
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'ProjectMind Secrets Scanner',
            version: '1.0.0',
            rules: [...new Set(findings.map((f) => f.type))].map((t) => ({ id: t })),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.type,
          level:
            f.severity === 'critical' || f.severity === 'high'
              ? 'error'
              : f.severity === 'medium'
                ? 'warning'
                : 'note',
          message: { text: `Potential ${f.type} detected` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file },
                region: { startLine: f.line },
              },
            },
          ],
        })),
      },
    ],
  };
}
