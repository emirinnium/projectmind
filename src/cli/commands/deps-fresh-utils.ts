import { reportSuppressedError } from '../../utils/errors.js';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export interface DependencyInfo {
  name: string;
  current: string;
  latest: string;
  type: 'prod' | 'dev' | 'peer' | 'optional';
  outdated: boolean;
  majorBehind: boolean;
  minorBehind: boolean;
  patchBehind: boolean;
  license?: string;
  repository?: string;
  description?: string;
  daysSinceUpdate?: number;
  cveCount?: number;
  deprecated?: boolean;
}

export interface LicensePolicy {
  allowed: Set<string>;
  denied: Set<string>;
}

export interface AuditSummary {
  total: number;
  critical: number;
  high: number;
  moderate: number;
  low: number;
}

export interface OutdatedEntry {
  current?: string;
  wanted?: string;
  latest?: string;
}

/** Resolve a package-manager executable without relying on shell lookup. */
export function resolvePackageManagerCommand(
  ecosystem: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!['npm', 'pnpm', 'yarn'].includes(ecosystem)) {
    throw new Error(`Unsupported package ecosystem: ${ecosystem}`);
  }
  return platform === 'win32' ? `${ecosystem}.cmd` : ecosystem;
}

export function generateMarkdownDeps(deps: DependencyInfo[], outdated: DependencyInfo[]): string {
  const lines = [
    '# Dependency Freshness Report',
    '',
    `**Generated:** ${new Date().toISOString().split('T')[0]}`,
    `**Total:** ${deps.length} | **Outdated:** ${outdated.length}`,
    '',
    '## All Dependencies',
    '',
    '| Name | Current | Latest | Type | Status |',
    '|------|---------|--------|------|--------|',
  ];

  for (const dep of deps) {
    const status = dep.outdated ? '🔴 Outdated' : '🟢 Current';
    lines.push(`| ${dep.name} | ${dep.current} | ${dep.latest} | ${dep.type} | ${status} |`);
  }

  if (outdated.length > 0) {
    lines.push('', '## Outdated Details', '');
    for (const dep of outdated) {
      lines.push(`### ${dep.name}`);
      lines.push(`- **Current:** ${dep.current}`);
      lines.push(`- **Latest:** ${dep.latest}`);
      lines.push(`- **Type:** ${dep.type}`);
      if (dep.majorBehind) lines.push(`- **Major versions behind:** Yes`);
      if (dep.minorBehind) lines.push(`- **Minor versions behind:** Yes`);
      if (dep.patchBehind) lines.push(`- **Patch versions behind:** Yes`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Run the real `npm audit --json` and summarize vulnerability severities.
 * Returns null when npm is unavailable or the project has no lockfile.
 */
export function runNpmAudit(projectRoot: string): AuditSummary | null {
  try {
    const result = spawnSync(resolvePackageManagerCommand('npm'), ['audit', '--json'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      // Resolve npm.cmd explicitly on Windows; never parse arguments through a shell.
      shell: false,
    });
    // npm audit exits non-zero when vulnerabilities exist; stdout still holds JSON.
    if (!result.stdout || !result.stdout.trim()) return null;
    const parsed = JSON.parse(result.stdout) as {
      metadata?: {
        vulnerabilities?: {
          info?: number;
          low?: number;
          moderate?: number;
          high?: number;
          critical?: number;
        };
      };
    };
    const v = parsed.metadata?.vulnerabilities;
    if (!v) return null;
    const total =
      (v.info ?? 0) + (v.low ?? 0) + (v.moderate ?? 0) + (v.high ?? 0) + (v.critical ?? 0);
    return {
      total,
      critical: v.critical ?? 0,
      high: v.high ?? 0,
      moderate: v.moderate ?? 0,
      low: v.low ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Real version data via `npm outdated --json`. Returns a map keyed by
 * package name; empty when everything is current or npm is unavailable.
 */
export function runPackageOutdated(
  projectRoot: string,
  ecosystem: string,
): Map<string, OutdatedEntry> {
  const result = new Map<string, OutdatedEntry>();
  try {
    const command = resolvePackageManagerCommand(ecosystem);
    const args = ecosystem === 'pnpm' ? ['outdated', '--format', 'json'] : ['outdated', '--json'];
    const proc = spawnSync(command, args, {
      cwd: projectRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      shell: false,
    });
    if (!proc.stdout || !proc.stdout.trim()) return result;
    const parsed = JSON.parse(proc.stdout) as
      | Record<string, OutdatedEntry>
      | Array<{ name?: string; current?: string; wanted?: string; latest?: string }>;
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry.name) result.set(entry.name, entry);
      }
    } else {
      for (const [name, entry] of Object.entries(parsed)) {
        if (entry && typeof entry === 'object') result.set(name, entry);
      }
    }
  } catch (error) {
    reportSuppressedError(error, 'Intentional fallback src/cli/commands/deps-fresh-utils.ts:156');
    // offline / no package manager: callers fall back to current-as-latest
  }
  return result;
}

export function optionEnabled(value: boolean | string | undefined): boolean {
  return value === undefined || value === true || value === 'true';
}

export function loadLicensePolicy(filePath: string): LicensePolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid license policy ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('License policy must be a JSON object with allowed and/or denied arrays.');
  }
  const record = parsed as Record<string, unknown>;
  const readList = (key: string): Set<string> => {
    const value = record[key];
    if (value === undefined) return new Set();
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      throw new Error(`License policy field "${key}" must be an array of strings.`);
    }
    return new Set(value.map((entry) => entry.trim()).filter(Boolean));
  };
  return { allowed: readList('allowed'), denied: readList('denied') };
}

export function severityRank(level: string): number {
  return { low: 1, medium: 2, high: 3, critical: 4 }[level] ?? 0;
}

export function highestFindingSeverity(
  outdated: DependencyInfo[],
  audit: AuditSummary | null,
  unknownLicenses: number,
): 'low' | 'medium' | 'high' | 'critical' | null {
  let highest: 'low' | 'medium' | 'high' | 'critical' | null = null;
  const consider = (level: 'low' | 'medium' | 'high' | 'critical'): void => {
    if (highest === null || severityRank(level) > severityRank(highest)) highest = level;
  };
  if (outdated.some((dependency) => dependency.majorBehind)) consider('high');
  else if (outdated.some((dependency) => dependency.minorBehind)) consider('medium');
  else if (outdated.length > 0) consider('low');
  if (audit) {
    if (audit.critical > 0) consider('critical');
    else if (audit.high > 0) consider('high');
    else if (audit.moderate > 0) consider('medium');
    else if (audit.low > 0) consider('low');
  }
  if (unknownLicenses > 0) consider('medium');
  return highest;
}
