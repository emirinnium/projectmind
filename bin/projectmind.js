#!/usr/bin/env node
// ProjectMind CLI wrapper - loads ESM module
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load the built CLI from dist
const cliPath = join(__dirname, '..', 'dist', 'cli.js');
await import(cliPath);