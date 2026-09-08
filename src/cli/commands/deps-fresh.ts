import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { loadConfig } from '@/cli/utils/shared.js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from '@/cli/utils/shared.js';
import { collectInstalledLicenses } from '@/cli/utils/license-scan.js';
import { confineToProject } from '@/mcp/tools/_shared.js';
import {
  generateMarkdownDeps,
  highestFindingSeverity,
  loadLicensePolicy,
  optionEnabled,
  runNpmAudit,
  runPackageOutdated,
  severityRank,
  type AuditSummary,
  type DependencyInfo,
} from './deps-fresh-utils.js';

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
    .option(
      '--fail-on <level>',
      'Exit code 1 if findings >= level: low|medium|high|critical',
      'high',
    )
    .option('--format <fmt>', 'Output: text|json|table|markdown', 'text')
    .option('-o, --output <file>', 'Write to file')
    .action(
      asyncHandler(
        async (opts: {
          major: boolean;
          minor: string;
          patch: string;
          ecosystem: string;
          audit: boolean;
          license: boolean;
          policy: string;
          failOn: string;
          format: string;
          output: string;
        }) => {
          if (!['npm', 'pnpm', 'yarn'].includes(opts.ecosystem)) {
            throw new Error(`--ecosystem must be npm, pnpm, or yarn: ${opts.ecosystem}`);
          }
          if (!['text', 'json', 'table', 'markdown'].includes(opts.format)) {
            throw new Error(`--format must be text, json, table, or markdown: ${opts.format}`);
          }
          if (!['low', 'medium', 'high', 'critical'].includes(opts.failOn)) {
            throw new Error(`--fail-on must be low, medium, high, or critical: ${opts.failOn}`);
          }
          await withService(['scale'], async (_ctx, _services) => {
            const config = loadConfig();
            const outputPath = opts.output
              ? confineToProject(opts.output, config.projectRoot)
              : undefined;
            const licensePolicy = opts.policy
              ? loadLicensePolicy(confineToProject(opts.policy, config.projectRoot))
              : null;
            const licenseCheck = opts.license || licensePolicy !== null;

            output.section('Dependency Freshness Monitor');
            output.kv('Ecosystem', opts.ecosystem);
            output.kv('Check major', opts.major ? 'yes' : 'no');
            output.kv('Check minor', opts.minor === 'true' ? 'yes' : 'no');
            output.kv('Check patch', opts.patch === 'true' ? 'yes' : 'no');
            output.kv('Security audit', opts.audit ? 'enabled' : 'disabled');
            output.kv('License check', licenseCheck ? 'enabled' : 'disabled');
            if (licensePolicy) output.kv('License policy', opts.policy);

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
            const npmOutdated = runPackageOutdated(config.projectRoot, opts.ecosystem);

            const depInfo: DependencyInfo[] = [];

            for (const name of depNames) {
              const current = allDeps[name].replace(/^[\^~]/, '');
              const od = npmOutdated.get(name);
              const latest = od?.latest ?? current;
              const currentParts = current.split('.').map(Number);
              const latestParts = latest.split('.').map(Number);
              const majorBehind = (latestParts[0] ?? 0) > (currentParts[0] ?? 0) && opts.major;
              const minorBehind =
                !majorBehind &&
                (latestParts[0] ?? 0) === (currentParts[0] ?? 0) &&
                (latestParts[1] ?? 0) > (currentParts[1] ?? 0) &&
                optionEnabled(opts.minor);
              const patchBehind =
                !majorBehind &&
                !minorBehind &&
                (latestParts[0] ?? 0) === (currentParts[0] ?? 0) &&
                (latestParts[1] ?? 0) === (currentParts[1] ?? 0) &&
                (latestParts[2] ?? 0) > (currentParts[2] ?? 0) &&
                optionEnabled(opts.patch);

              depInfo.push({
                name,
                current,
                latest,
                type: pkg.dependencies?.[name]
                  ? 'prod'
                  : pkg.devDependencies?.[name]
                    ? 'dev'
                    : pkg.peerDependencies?.[name]
                      ? 'peer'
                      : 'optional',
                outdated: Boolean(od),
                majorBehind,
                minorBehind,
                patchBehind,
                license: installedLicenses.get(name) ?? '',
              });
            }

            if (!npmOutdated.size && depNames.length > 0) {
              output.info(
                'npm outdated returned nothing — dependencies are current or registry unreachable',
              );
            }
            const outdatedDeps = depInfo.filter((d) => d.outdated);
            let audit: AuditSummary | null = null;
            if (opts.audit && opts.ecosystem === 'npm') {
              audit = runNpmAudit(config.projectRoot);
            }
            const licenseUnknown = licenseCheck
              ? depInfo.filter((dependency) => !dependency.license).length
              : 0;
            const deniedLicenses = licensePolicy
              ? depInfo.filter((dependency) => {
                  const license = dependency.license ?? '';
                  return license.length > 0 && licensePolicy.denied.has(license);
                }).length
              : 0;
            const notAllowedLicenses = licensePolicy
              ? depInfo.filter((dependency) => {
                  const license = dependency.license ?? '';
                  return (
                    license.length > 0 &&
                    licensePolicy.allowed.size > 0 &&
                    !licensePolicy.allowed.has(license)
                  );
                }).length
              : 0;
            const highestSeverity = highestFindingSeverity(
              outdatedDeps,
              audit,
              licenseUnknown + deniedLicenses + notAllowedLicenses,
            );
            if (highestSeverity && severityRank(highestSeverity) >= severityRank(opts.failOn)) {
              process.exitCode = 1;
              output.warn(
                `Findings reached --fail-on ${opts.failOn} (highest: ${highestSeverity}).`,
              );
            }

            if (opts.format === 'json') {
              const result = {
                dependencies: depInfo,
                outdated: outdatedDeps,
                audit,
                license: licenseCheck
                  ? {
                      unknown: licenseUnknown,
                      denied: deniedLicenses,
                      notAllowed: notAllowedLicenses,
                    }
                  : null,
                summary: {
                  total: depInfo.length,
                  outdated: outdatedDeps.length,
                  prod: depInfo.filter((d) => d.type === 'prod').length,
                  dev: depInfo.filter((d) => d.type === 'dev').length,
                },
              };
              const content = JSON.stringify(result, null, 2);
              if (outputPath) {
                writeFileSync(outputPath, content);
                output.success(`Written to ${outputPath}`);
              } else {
                output.raw(content);
              }
              return;
            }

            if (opts.format === 'markdown') {
              const content = generateMarkdownDeps(depInfo, outdatedDeps);
              if (outputPath) {
                writeFileSync(outputPath, content);
                output.success(`Written to ${outputPath}`);
              } else {
                output.raw(content);
              }
              return;
            }

            if (opts.format === 'table') {
              const rows = depInfo.map((dependency) => ({
                name: dependency.name,
                current: dependency.current,
                latest: dependency.latest,
                type: dependency.type,
                status: dependency.outdated ? 'outdated' : 'current',
              }));
              if (outputPath) {
                writeFileSync(
                  outputPath,
                  rows.map((row) => Object.values(row).join('\t')).join('\n'),
                );
                output.success(`Written to ${outputPath}`);
              } else {
                output.table(rows);
              }
              return;
            }

            // Text format
            output.section(`Dependency Summary`);
            output.kv('Total', depInfo.length);
            output.kv('Production', depInfo.filter((d) => d.type === 'prod').length);
            output.kv('Development', depInfo.filter((d) => d.type === 'dev').length);
            output.kv('Outdated', outdatedDeps.length);

            if (outdatedDeps.length > 0) {
              output.section(`Outdated Dependencies (${outdatedDeps.length})`);
              for (const dep of outdatedDeps.slice(0, 30)) {
                const behind = [];
                if (dep.majorBehind) behind.push('major');
                if (dep.minorBehind) behind.push('minor');
                if (dep.patchBehind) behind.push('patch');
                const behindStr = behind.length > 0 ? ` (${behind.join(', ')} behind)` : '';
                output.kv(
                  `  ${dep.name}`,
                  `${dep.current} → ${dep.latest}${behindStr} [${dep.type}]`,
                );
              }
            } else {
              output.success('All dependencies are up to date!');
            }

            if (opts.audit) {
              output.section('Security Audit');
              if (opts.ecosystem !== 'npm') {
                output.warn('Security audit is currently supported only for npm lockfiles.');
              } else if (!audit) {
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

            if (licenseCheck) {
              output.section('License Compliance');
              const licenses = depInfo.map((d) => d.license).filter(Boolean);
              const unknown = depInfo.filter((d) => !d.license).length;
              const uniqueLicenses = [...new Set(licenses)];
              output.kv('Packages with known license', licenses.length);
              if (unknown > 0) output.kv('Unknown license', String(unknown));
              if (deniedLicenses > 0) output.kv('Denied licenses', String(deniedLicenses));
              if (notAllowedLicenses > 0)
                output.kv('Not allowed by policy', String(notAllowedLicenses));
              for (const lic of uniqueLicenses.sort()) {
                const count = licenses.filter((l) => l === lic).length;
                output.kv(`  ${lic}`, `${count} pkg`);
              }
            }

            if (outputPath) {
              const result = {
                dependencies: depInfo,
                outdated: outdatedDeps,
                audit,
                license: licenseCheck
                  ? {
                      unknown: licenseUnknown,
                      denied: deniedLicenses,
                      notAllowed: notAllowedLicenses,
                    }
                  : null,
              };
              writeFileSync(outputPath, JSON.stringify(result, null, 2));
              output.success(`Written to ${outputPath}`);
            }
          });
        },
      ),
    );

  return depsCmd;
}
