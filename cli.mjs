#!/usr/bin/env node
// ProjectMind CLI entry point - loads the built CLI from dist
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load the built CLI from dist.
// Windows: dynamic import() requires a file:// URL — passing the raw
// 'C:\\...' path throws ERR_UNSUPPORTED_ESM_URL_SCHEME (drive letter parsed
// as a URL scheme). pathToFileURL converts safely on every platform.
const cliPath = join(__dirname, 'dist', 'cli.js');
if (!existsSync(cliPath)) {
  process.stderr.write(
    `ProjectMind is not built: ${cliPath}\nRun "npm run build", then retry.\n`,
  );
  process.exitCode = 1;
} else {
  try {
    await import(pathToFileURL(cliPath).href);
  } catch (error) {
    process.stderr.write(
      `ProjectMind CLI failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
