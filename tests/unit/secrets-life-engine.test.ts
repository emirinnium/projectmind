import { describe, expect, it } from 'vitest';
import type { ProjectMindConfig } from '../../src/utils/config.js';
import {
  DEFAULT_POLICIES,
  checkVaultIntegration,
  generateRotationSchedule,
  generateSarif,
  scanForSecrets,
} from '../../src/cli/commands/secrets-life-engine.js';

describe('secrets-life engine', () => {
  it('detects and masks high-entropy configured secrets with source locations', () => {
    const findings = scanForSecrets(
      'const apiKey = "aB9xQ2mN7pL4vR8sT1yU6zC3dF5gH0jK";',
      'src/config.ts',
      2,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      type: 'api-key',
      file: 'src/config.ts',
      line: 1,
      severity: 'high',
      rotationDays: 90,
    });
    expect(findings[0].maskedValue).not.toContain('aB9xQ2mN7pL4vR8sT1yU6zC3dF5gH0jK');
  });

  it('filters low-entropy values and still recognizes private-key markers', () => {
    expect(scanForSecrets('const token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa";', 'a.ts', 2)).toHaveLength(0);
    expect(
      scanForSecrets('-----BEGIN RSA PRIVATE KEY-----', 'keys/key.pem', 0),
    ).toMatchObject([
      {
        type: 'private-key',
        file: 'keys/key.pem',
        line: 1,
        severity: 'critical',
      },
    ]);
  });

  it('returns a deterministic rotation order and SARIF shape', () => {
    const schedule = generateRotationSchedule(DEFAULT_POLICIES);

    expect(schedule.length).toBe(Object.keys(DEFAULT_POLICIES).length);
    expect(schedule.map((item) => item.daysUntilRotation)).toEqual(
      [...schedule.map((item) => item.daysUntilRotation)].sort((a, b) => a - b),
    );
    expect(generateSarif([])).toMatchObject({
      version: '2.1.0',
      runs: [{ tool: { driver: { name: 'ProjectMind Secrets Scanner' } }, results: [] }],
    });
  });

  it('keeps Vault integration configuration read-only and preserves configured mount paths', () => {
    const result = checkVaultIntegration({
      vault: { mountPaths: ['team-secrets/'] },
    } as ProjectMindConfig & { vault: { mountPaths: string[] } });

    expect(result.mountPaths).toEqual(['team-secrets/']);
    expect(result.address).toBe(process.env.VAULT_ADDR);
  });
});
