#!/usr/bin/env node
// ProjectMind CLI entry point - loads built ESM module from dist/
// Works both locally (dev) and globally (npm install -g)
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Try multiple locations for dist/cli.js
const possiblePaths = [
  // Local development: cli.mjs at package root, dist/ sibling
  join(__dirname, 'dist', 'cli.js'),
  // Global install: bin/cli.mjs -> package root is ../../
  join(__dirname, '..', '..', 'lib', 'node_modules', '@emirhanturker', 'projectmind', 'dist', 'cli.js'),
  // Alternative global structure (npm v7+)
  join(__dirname, '..', '..', 'node_modules', '@emirhanturker', 'projectmind', 'dist', 'cli.js'),
  // Yarn/pnpm global
  join(__dirname, '..', '..', '..', 'lib', 'node_modules', '@emirhanturker', 'projectmind', 'dist', 'cli.js'),
];

let cliPath = null;
for (const p of possiblePaths) {
  const resolved = resolve(p);
  if (existsSync(resolved)) {
    cliPath = resolved;
    break;
  }
}

if (!cliPath) {
  console.error('Error: Could not find ProjectMind CLI (dist/cli.js)');
  console.error('Tried paths:', possiblePaths.map(p => resolve(p)));
  process.exit(1);
}

await import(cliPath);