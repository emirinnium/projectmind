import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { loadConfig } from '@/cli/utils/shared.js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from '@/cli/utils/shared.js';
import { collectInstalledLicenses } from '@/cli/utils/license-scan.js';

interface DependencyInfo {
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

export function createDepsFreshCommand(): Command {
  const depsCmd = new Command('deps-fresh')
    .description('Monitor dependency freshness, vulnerabilities, and license compliance')
    .option('--major', 'Include major version updates in outdated check')
    .option('--minor', 'Include minor version updates', 'true')
    .option('--patch', 'Include patch version updates', 'true')
    .option('--ecosystem <eco>', 'Package ecosystem: npm|pnpm|yarn', 'npm')
    .option('--audit', 'Run security audit (CVE check)')
    .option('--license', 'Check license compliance')
    .option('--policy <file>', 'License policy file (allowed/denied licenses)')
    .option('--fail-on <level>', 'Exit code 1 if findings >= level: low|medium|high|critical', 'high')
    .option('--format <fmt>', 'Output: text|json|table|markdown', 'text')
    .option('-o, --output <file>', 'Write to file')
    .action(asyncHandler(async (opts: { major: boolean; minor: string; patch: string; ecosystem: string; audit: boolean; license: boolean; policy: string; failOn: string; format: string; output: string }) => {
      await withService(['scale'], async (_ctx, services) => {
        services.scale!;
        const config = loadConfig();
        
        output.section('Dependency Freshness Monitor');
        output.kv('Ecosystem', opts.ecosystem);
        output.kv('Check major', opts.major ? 'yes' : 'no');
        output.kv('Check minor', opts.minor === 'true' ? 'yes' : 'no');
        output.kv('Check patch', opts.patch === 'true' ? 'yes' : 'no');
        output.kv('Security audit', opts.audit ? 'enabled' : 'disabled');
        output.kv('License check', opts.license ? 'enabled' : 'disabled');
        
        const pkgPath = join(config.projectRoot, 'package.json');
        if (!existsSync(pkgPath)) {
          output.warn('No package.json found');
          return;
        }
        
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const allDeps = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
          ...pkg.peerDependencies,
          ...pkg.optionalDependencies,
        };
        
        const depNames = Object.keys(allDeps);
        output.kv('Total dependencies', depNames.length);
        
        // Real freshness data from the installed tree + `npm outdated --json`.
        const installedLicenses = collectInstalledLicenses(config.projectRoot);
        const npmOutdated = runNpmOutdated(config.projectRoot);

        const depInfo: DependencyInfo[] = [];

        for (const name of depNames) {
          const current = allDeps[name].replace(/^[\^~]/, '');
          const od = npmOutdated.get(name);
          const latest = od?.latest ?? current;
          const currentParts = current.split('.').map(Number);
          const latestParts = latest.split('.').map(Number);
          const majorBehind = (latestParts[0] ?? 0) > (currentParts[0] ?? 0) && opts.major;
          const minorBehind = !majorBehind && (latestParts[0] ?? 0) === (currentParts[0] ?? 0)
            && (latestParts[1] ?? 0) > (currentParts[1] ?? 0) && opts.minor === 'true';
          const patchBehind = !majorBehind && !minorBehind
            && (latestParts[0] ?? 0) === (currentParts[0] ?? 0)
            && (latestParts[1] ?? 0) === (currentParts[1] ?? 0)
            && (latestParts[2] ?? 0) > (currentParts[2] ?? 0) && opts.patch === 'true';

          depInfo.push({
            name,
            current,
            latest,
            type: pkg.dependencies?.[name] ? 'prod' : pkg.devDependencies?.[name] ? 'dev' : 'peer',
            outdated: Boolean(od),
            majorBehind,
            minorBehind,
            patchBehind,
            license: installedLicenses.get(name) ?? '',
          });
        }

        if (!npmOutdated.size && depNames.length > 0) {
          output.info('npm outdated returned nothing — dependencies are current or registry unreachable');
        }
        const outdatedDeps = depInfo.filter(d => d.outdated);
        
        if (opts.format === 'json') {
          const result = { dependencies: depInfo, outdated: outdatedDeps, summary: { total: depInfo.length, outdated: outdatedDeps.length, prod: depInfo.filter(d => d.type === 'prod').length, dev: depInfo.filter(d => d.type === 'dev').length } };
          const content = JSON.stringify(result, null, 2);
          if (opts.output) {
            writeFileSync(opts.output, content);
            output.success(`Written to ${opts.output}`);
          } else {
            console.log(content);
          }
          return;
        }
        
        if (opts.format === 'markdown') {
          const content = generateMarkdownDeps(depInfo, outdatedDeps);
          if (opts.output) {
            writeFileSync(opts.output, content);
            output.success(`Written to ${opts.output}`);
          } else {
            console.log(content);
          }
          return;
        }
        
        // Text format
        output.section(`Dependency Summary`);
        output.kv('Total', depInfo.length);
        output.kv('Production', depInfo.filter(d => d.type === 'prod').length);
        output.kv('Development', depInfo.filter(d => d.type === 'dev').length);
        output.kv('Outdated', outdatedDeps.length);
        
        if (outdatedDeps.length > 0) {
          output.section(`Outdated Dependencies (${outdatedDeps.length})`);
          for (const dep of outdatedDeps.slice(0, 30)) {
            const behind = [];
            if (dep.majorBehind) behind.push('major');
            if (dep.minorBehind) behind.push('minor');
            if (dep.patchBehind) behind.push('patch');
            const behindStr = behind.length > 0 ? ` (${behind.join(', ')} behind)` : '';
            output.kv(`  ${dep.name}`, `${dep.current} → ${dep.latest}${behindStr} [${dep.type}]`);
          }
        } else {
          output.success('All dependencies are up to date!');
        }
        
        if (opts.audit) {
          output.section('Security Audit');
          const audit = runNpmAudit();
          if (!audit) {
            output.warn('npm audit could not be executed (offline or npm unavailable)');
          } else if (audit.total === 0) {
            output.success('No known vulnerabilities found');
          } else {
            output.kv('Vulnerabilities', audit.total);
            if (audit.critical > 0) output.kv('  Critical', audit.critical);
            if (audit.high > 0) output.kv('  High', audit.high);
            if (audit.moderate > 0) output.kv('  Moderate', audit.moderate);
            if (audit.low > 0) output.kv('  Low', audit.low);
          }
        }
        
        if (opts.license) {
          output.section('License Compliance');
          const licenses = depInfo.map(d => d.license).filter(Boolean);
          const unknown = depInfo.filter(d => !d.license).length;
          const uniqueLicenses = [...new Set(licenses)];
          output.kv('Packages with known license', licenses.length);
          if (unknown > 0) output.kv('Unknown license', String(unknown));
          for (const lic of uniqueLicenses.sort()) {
            const count = licenses.filter((l) => l === lic).length;
            output.kv(`  ${lic}`, `${count} pkg`);
          }
        }
        
        if (opts.output) {
          const result = { dependencies: depInfo, outdated: outdatedDeps };
          writeFileSync(opts.output, JSON.stringify(result, null, 2));
          output.success(`Written to ${opts.output}`);
        }
      });
    }));
  
  return depsCmd;
}

function generateMarkdownDeps(deps: DependencyInfo[], outdated: DependencyInfo[]): string {
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
interface AuditSummary { total: number; critical: number; high: number; moderate: number; low: number }

/**
 * Run the real `npm audit --json` and summarize vulnerability severities.
 * Returns null when npm is unavailable or the project has no lockfile.
 */
function runNpmAudit(): AuditSummary | null {
  try {
    const result = spawnSync('npm', ['audit', '--json'], {
      cwd: loadConfig().projectRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      // npm is a .cmd shim on Windows; plain spawn would fail with ENOENT.
      // Args are static literals, so the shell adds no injection surface.
      shell: true,
    });
    // npm audit exits non-zero when vulnerabilities exist; stdout still holds JSON.
    if (!result.stdout || !result.stdout.trim()) return null;
    const parsed = JSON.parse(result.stdout) as {
      metadata?: { vulnerabilities?: { info?: number; low?: number; moderate?: number; high?: number; critical?: number } };
    };
    const v = parsed.metadata?.vulnerabilities;
    if (!v) return null;
    const total = (v.info ?? 0) + (v.low ?? 0) + (v.moderate ?? 0) + (v.high ?? 0) + (v.critical ?? 0);
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

interface OutdatedEntry { current?: string; wanted?: string; latest?: string }

/**
 * Real version data via `npm outdated --json`. Returns a map keyed by
 * package name; empty when everything is current or npm is unavailable.
 */
function runNpmOutdated(projectRoot: string): Map<string, OutdatedEntry> {
  const result = new Map<string, OutdatedEntry>();
  try {
    const proc = spawnSync('npm', ['outdated', '--json'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      shell: true, // npm is a .cmd shim on Windows
    });
    if (!proc.stdout || !proc.stdout.trim()) return result;
    const parsed = JSON.parse(proc.stdout) as Record<string, OutdatedEntry>;
    for (const [name, entry] of Object.entries(parsed)) {
      if (entry && typeof entry === 'object') result.set(name, entry);
    }
  } catch {
    // offline / no npm: callers fall back to current-as-latest
  }
  return result;
}
