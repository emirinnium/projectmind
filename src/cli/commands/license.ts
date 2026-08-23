import { Command } from 'commander';
import { asyncHandler, output } from '@/cli/utils/shared.js';
import { loadConfig } from '@/cli/utils/shared.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from '@/cli/utils/shared.js';

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
    .action(asyncHandler(async () => {
      output.section('License Report');
      output.info('Basic license info available in package.json');
      output.info('For full SPDX compliance, use dedicated tools like license-checker');
    }));

  return licenseCmd;
}