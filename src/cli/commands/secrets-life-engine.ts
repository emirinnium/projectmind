import type { ProjectMindConfig } from '@/utils/config.js';
import { currentModuleDir, resolvePackageVersion } from '@/cli/utils/version.js';

const packageVersion = resolvePackageVersion(currentModuleDir(import.meta.url));

export interface SecretFinding {
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

export interface RotationPolicy {
  type: string;
  maxAgeDays: number;
  autoRotate: boolean;
  vaultPath?: string;
}

export const DEFAULT_POLICIES: Record<string, RotationPolicy> = {
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

export function scanForSecrets(
  content: string,
  relativePath: string,
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

export function generateRotationSchedule(
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

export function checkVaultIntegration(
  config: ProjectMindConfig & { vault?: { mountPaths?: string[] } },
): {
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

export function generateSarif(findings: SecretFinding[]): SarifReport {
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'ProjectMind Secrets Scanner',
            version: packageVersion,
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
