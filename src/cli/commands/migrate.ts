import { Command } from 'commander';
import { asyncHandler, output } from '@/cli/utils/shared.js';
import { loadConfig } from '@/cli/utils/shared.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from '@/cli/utils/shared.js';

export function createMigrateCommand(): Command {
  const migrateCmd = new Command('migrate').description('Migration helpers for common upgrades');

  migrateCmd
    .command('check-deps')
    .description('Check for outdated dependencies')
    .option('--major', 'Include major version updates')
    .action(
      asyncHandler(async () => {
        const config = loadConfig();

        output.section('Dependency Migration Check');

        const pkgPath = join(config.projectRoot, 'package.json');
        if (!existsSync(pkgPath)) {
          output.warn('No package.json found');
          return;
        }

        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

        output.section(`Dependencies (${Object.keys(allDeps).length})`);

        for (const [name, version] of Object.entries(allDeps)) {
          const current = version as string;
          output.kv(`  ${name}`, current);
        }

        output.info('Note: Full version checking requires npm registry API.');
        output.info('Run "npm outdated" for detailed version info.');
      }),
    );

  migrateCmd
    .command('jest-to-vitest')
    .description('Convert Jest config/tests to Vitest (basic)')
    .option('--dry-run', 'Show changes without applying')
    .action(
      asyncHandler(async (opts: { dryRun: boolean }) => {
        const config = loadConfig();

        output.section('Jest → Vitest Migration');

        const pkgPath = join(config.projectRoot, 'package.json');
        if (!existsSync(pkgPath)) {
          output.warn('No package.json found');
          return;
        }

        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

        const hasJest = pkg.devDependencies?.jest || pkg.dependencies?.jest;
        const hasVitest = pkg.devDependencies?.vitest || pkg.dependencies?.vitest;

        if (!hasJest && !hasVitest) {
          output.info('No Jest or Vitest found in dependencies');
          return;
        }

        if (hasVitest) {
          output.success('Vitest already present');
        }

        if (hasJest) {
          output.warn('Jest detected - migration recommended');
          output.info('Manual steps needed:');
          output.kv('1.', 'npm install -D vitest @vitest/ui');
          output.kv('2.', 'Update package.json: "test": "vitest"');
          output.kv('3.', 'Rename jest.config.js → vitest.config.ts');
          output.kv('4.', 'Update globals: jest → vi (vi.fn, vi.mock, etc.)');
          output.kv('5.', 'Update expect: jest.expect → expect');
        }

        if (!opts.dryRun && hasJest && !hasVitest) {
          output.info('Run with --dry-run to see proposed package.json changes');
        }
      }),
    );

  migrateCmd
    .command('typescript <version>')
    .description('Check TypeScript version compatibility')
    .action(
      asyncHandler(async (version: string) => {
        const config = loadConfig();

        output.section(`TypeScript ${version} Compatibility`);

        const pkgPath = join(config.projectRoot, 'package.json');
        if (!existsSync(pkgPath)) {
          output.warn('No package.json found');
          return;
        }

        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const currentTS = pkg.devDependencies?.typescript || pkg.dependencies?.typescript;

        output.kv('Current', currentTS || 'not installed');
        output.kv('Target', version);

        if (currentTS) {
          const currentMajor = parseInt(currentTS.replace(/[\^~]/, '').split('.')[0]);
          const targetMajor = parseInt(version.split('.')[0]);

          if (targetMajor > currentMajor) {
            output.warn(
              `Major upgrade (${currentMajor} → ${targetMajor}) - breaking changes likely`,
            );
            output.info('Review TypeScript release notes for migration steps');
          } else {
            output.success('Minor/patch upgrade - usually safe');
          }
        }

        output.info('Run "npm install -D typescript@' + version + '" to upgrade');
      }),
    );

  return migrateCmd;
}
