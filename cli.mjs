#!/usr/bin/env node
// ProjectMind CLI entry point - loads built ESM module from dist/
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load the built CLI from dist/ using async IIFE
(async () => {
  const cliPath = join(__dirname, 'dist', 'cli.js');
  await import(cliPath);
})().catch((err) => {
  console.error('Failed to load ProjectMind CLI:', err);
  process.exit(1);
});