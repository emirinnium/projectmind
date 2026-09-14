#!/usr/bin/env node
import { reportSuppressedError } from './utils/errors.js';
import { Command } from 'commander';
import { logger } from './utils/logger.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { currentModuleDir, resolvePackageVersion } from './cli/utils/version.js';
import { buildProgram } from './cli/program.js';
import { confineOutputPathFlags } from './mcp/tools/_shared.js';
import { loadConfig } from './utils/config.js';
import { allowRootOutsideProject, getStartupProjectRoot } from './cli/utils/startup-security.js';

const pkgVersion = resolvePackageVersion(currentModuleDir(import.meta.url));
const cliArgs = process.argv.slice(2);
const formatIndex = cliArgs.indexOf('--format');
const requestedFormat =
  cliArgs.find((arg) => arg.startsWith('--format='))?.slice('--format='.length) ??
  (formatIndex >= 0 ? cliArgs[formatIndex + 1] : undefined);
const machineFormats = new Set([
  'json',
  'html',
  'markdown',
  'mermaid',
  'd3',
  'spdx',
  'spdx-tag',
  'cyclonedx',
  'sarif',
  'csv',
]);
const machineOutput =
  cliArgs[0] === 'mcp' ||
  cliArgs.includes('--json') ||
  (requestedFormat !== undefined && machineFormats.has(requestedFormat));
logger.setMachineMode(machineOutput);

// Display ASCII banner on startup
try {
  const logoPath = join(currentModuleDir(import.meta.url), '..', 'assets', 'cli-logo.txt');
  const logo = readFileSync(logoPath, 'utf-8');
  if (!machineOutput) {
    console.log(logo);
    console.log('');
  }
} catch (error) {
  reportSuppressedError(error, 'Intentional fallback src/cli.ts:43');
  // Logo file not found, skip banner
}

const program = new Command();
let startupBlocked = false;

try {
  const cliArgs = process.argv.slice(2);
  const configuredRoot = loadConfig().projectRoot;
  confineOutputPathFlags(cliArgs, getStartupProjectRoot(cliArgs, configuredRoot), {
    allowRootOutsideProject: allowRootOutsideProject(cliArgs),
  });
} catch (error: unknown) {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  startupBlocked = true;
}

program
  .name('projectmind')
  .description('Living Codebase Intelligence Layer for AI Agents')
  .version(pkgVersion);

if (!startupBlocked) {
  buildProgram()
    .then(async (loaded) => {
      // Merge every registered command from the shared builder into the root
      // program that owns version/banner/exit handling.
      for (const cmd of loaded.commands) {
        program.addCommand(cmd);
      }

      // Keep Commander in its default mode. Commands set process.exitCode on
      // expected failures so their context/service cleanup can finish first.

      await program.parseAsync(process.argv).catch((err: unknown) => {
        logger.error(`CLI error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      });
    })
    .catch((err: unknown) => {
      logger.error(`Failed to initialize CLI: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
