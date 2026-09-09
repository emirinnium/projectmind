import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distPath = resolve(projectRoot, 'dist');

// Keep the deletion target explicit and project-confined. This prevents a
// mislocated script invocation from ever removing an arbitrary directory.
if (dirname(distPath) !== projectRoot || distPath !== resolve(projectRoot, 'dist')) {
  throw new Error(`Refusing to clean an unexpected dist path: ${distPath}`);
}

await rm(distPath, { recursive: true, force: true });
