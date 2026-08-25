import { Command } from 'commander';
import { asyncHandler, output } from '@/cli/utils/shared.js';
import { loadConfig } from '@/cli/utils/shared.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from '@/cli/utils/shared.js';
import { collectInstalledLicenses } from '@/cli/utils/license-scan.js';

export function createLicenseCommand(): Command {
  const licenseCmd = new Command('license')
    .description('License compliance (basic check)')
    .action(asyncHandler(async () => {
      // Default view when invoked without a subcommand.
      const config = loadConfig();
      const pkgPath = join(config.projectRoot, 'package.json');
      if (!existsSync(pkgPath)) {
        output.warn('No package.json found');
        return;
      }
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        output.section('License Overview');
        output.kv('Project', pkg.name);
        output.kv('Version', pkg.version);
        output.kv('License', pkg.license || 'UNKNOWN');
        output.kv('Dependencies', Object.keys(pkg.dependencies ?? {}).length);
        output.info('Subcommands: license check | license report');
      } catch (e) {
        output.error(`Failed to parse package.json: ${e}`);
      }
    }));

  licenseCmd
    .command('check')
    .description('Check licenses in package.json')
    .option('--format <fmt>', 'Output: text|json', 'text')
    .action(asyncHandler(async (opts: { format: string }) => {
      const config = loadConfig();
      
      output.section('License Check');
      
      const pkgPath = join(config.projectRoot, 'package.json');
      
      if (!existsSync(pkgPath)) {
        output.warn('No package.json found');
        return;
      }
      
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        output.kv('Project', pkg.name);
        output.kv('Version', pkg.version);
        output.kv('License', pkg.license || 'UNKNOWN');
        
        if (pkg.dependencies) {
          output.section(`Dependencies (${Object.keys(pkg.dependencies).length})`);
          for (const [name, version] of Object.entries(pkg.dependencies)) {
            output.kv(`  ${name}`, version as string);
          }
        }
        
        if (opts.format === 'json') {
          console.log(JSON.stringify(pkg, null, 2));
        }
      } catch (e) {
        output.error(`Failed to parse package.json: ${e}`);
      }
    }));

  licenseCmd
    .command('report')
    .description('Generate license report')
    .option('--format <fmt>', 'Output: text|json', 'text')
    .option('-o, --output <file>', 'Write to file')
    .action(asyncHandler(async (opts: { format: string; output?: string }) => {
      const config = loadConfig();
      const pkgPath = join(config.projectRoot, 'package.json');
      if (!existsSync(pkgPath)) {
        output.warn('No package.json found');
        return;
      }

      let projectName = 'unknown';
      try {
        projectName = (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string }).name ?? 'unknown';
      } catch {
        // Non-fatal: report can proceed without project name.
      }

      // Real scan of installed packages (shared with deps-fresh).
      const installed = collectInstalledLicenses(config.projectRoot);
      if (installed.size === 0) {
        output.warn('No installed packages found — run "npm install" first.');
        return;
      }

      const byLicense = new Map<string, string[]>();
      for (const [pkg, lic] of installed) {
        const key = lic || 'UNKNOWN';
        const list = byLicense.get(key) ?? [];
        list.push(pkg);
        byLicense.set(key, list);
      }

      const licensesSorted = [...byLicense.entries()].sort((a, b) => b[1].length - a[1].length);
      const unknownPkgs = byLicense.get('UNKNOWN') ?? [];
      const result = {
        project: projectName,
        totalPackages: installed.size,
        knownLicenses: Object.fromEntries(licensesSorted.filter(([lic]) => lic !== 'UNKNOWN')),
        unknownCount: unknownPkgs.length,
        unknownPackages: unknownPkgs,
      };

      if (opts.format === 'json') {
        const content = JSON.stringify(result, null, 2);
        if (opts.output) {
          writeFileSync(opts.output, content);
          output.success(`Written to ${opts.output}`);
        } else {
          console.log(content);
        }
        return;
      }

      output.section(`License Report — ${projectName}`);
      output.kv('Installed packages', String(installed.size));
      for (const [lic, pkgs] of licensesSorted) {
        output.kv(`  ${lic}`, `${pkgs.length} package(s)`);
      }
      if (unknownPkgs.length > 0) {
        output.section(`Packages Without License Field (${unknownPkgs.length})`);
        for (const pkg of unknownPkgs.slice(0, 15)) {
          output.kv(`  ⚠️ ${pkg}`, 'no license declared in package.json');
        }
        if (unknownPkgs.length > 15) {
          output.info(`...and ${unknownPkgs.length - 15} more`);
        }
      }
      if (opts.output) {
        writeFileSync(opts.output, JSON.stringify(result, null, 2));
        output.success(`Written to ${opts.output}`);
      }
    }));

  return licenseCmd;
}