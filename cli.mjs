#!/usr/bin/env node
// ProjectMind CLI entry point - loads the built CLI from dist
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load the built CLI from dist.
// Windows: dynamic import() requires a file:// URL — passing the raw
// 'C:\...' path throws ERR_UNSUPPORTED_ESM_URL_SCHEME (drive letter parsed
// as a URL scheme). pathToFileURL converts safely on every platform.
const cliPath = join(__dirname, 'dist', 'cli.js');
await import(pathToFileURL(cliPath).href);
