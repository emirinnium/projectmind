#!/usr/bin/env node
import { Command } from 'commander';
import { logger } from './utils/logger.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { currentModuleDir, resolvePackageVersion } from './cli/utils/version.js';
import { buildProgram } from './cli/program.js';

const pkgVersion = resolvePackageVersion(currentModuleDir(import.meta.url));

// Display ASCII banner on startup
try {
  const logoPath = join(currentModuleDir(import.meta.url), '..', 'assets', 'cli-logo.txt');
  const logo = readFileSync(logoPath, 'utf-8');
  console.log(logo);
  console.log('');
} catch {
  // Logo file not found, skip banner
}

const program = new Command();

program
  .name('projectmind')
  .description('Living Codebase Intelligence Layer for AI Agents')
  .version(pkgVersion);

buildProgram()
  .then(async (loaded) => {
    // Merge every registered command from the shared builder into the root
    // program that owns version/banner/exit handling.
    for (const cmd of loaded.commands) {
      program.addCommand(cmd);
    }

    // NOTE: exitOverride is intentionally NOT used here.
    //
    // With exitOverride active, commander intercepts process.exit() calls
    // made by action handlers and re-throws them as CommanderError. Since
    // asyncHandler calls process.exit(0) on success, every successful
    // command would be caught as an "error" and re-exited with code 1.
    // Without exitOverride, process.exit() calls pass through directly,
    // giving correct exit codes for free.

    await program.parseAsync(process.argv).catch((err: unknown) => {
      logger.error(`CLI error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  })
  .catch((err: unknown) => {
    logger.error(`Failed to initialize CLI: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
