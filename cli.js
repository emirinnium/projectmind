#!/usr/bin/env node
// ProjectMind CLI entry point - loads built ESM module from dist/
const { join, dirname } = require('path');
const { fileURLToPath } = require('url');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load the built CLI from dist/
const cliPath = join(__dirname, 'dist', 'cli.js');
require(cliPath);