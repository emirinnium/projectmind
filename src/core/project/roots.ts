import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { PathSecurityError } from '../security/path-security.js';

/** Validate a separately managed project root; unlike file paths it may be outside the active root. */
export function resolveProjectRoot(inputPath: string, cwd = process.cwd()): string {
  if (!inputPath.trim())
    throw new PathSecurityError(
      'empty-path',
      inputPath,
      cwd,
      'Provide an existing project directory.',
    );
  if (inputPath.includes('\0') || [...inputPath].some((char) => char.charCodeAt(0) < 0x20)) {
    throw new PathSecurityError(
      'control-character',
      inputPath,
      cwd,
      'Remove control characters from the project path.',
    );
  }
  const absolute = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  let canonical: string;
  try {
    canonical = realpathSync.native(absolute);
  } catch (error) {
    throw new PathSecurityError(
      'not-a-file',
      inputPath,
      cwd,
      `Project root must exist and be readable. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!statSync(canonical).isDirectory())
    throw new PathSecurityError('not-a-file', inputPath, cwd, 'Project root must be a directory.');
  return canonical;
}
