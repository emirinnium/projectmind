import { chmodSync, existsSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

/** Replace one known file safely on both POSIX and Windows filesystems. */
export function writeFileAtomically(filePath: string, content: string): void {
  const directory = dirname(filePath);
  const name = basename(filePath);
  const suffix = `${process.pid}-${Date.now()}`;
  const tempPath = resolve(directory, `.${name}.projectmind-${suffix}.tmp`);
  const backupPath = resolve(directory, `.${name}.projectmind-${suffix}.bak`);
  const mode = existsSync(filePath) ? statSync(filePath).mode : 0o600;
  try {
    writeFileSync(tempPath, content, { encoding: 'utf8', mode });
    chmodSync(tempPath, mode);
    if (process.platform !== 'win32') {
      renameSync(tempPath, filePath);
      return;
    }

    if (!existsSync(filePath)) {
      renameSync(tempPath, filePath);
      return;
    }
    renameSync(filePath, backupPath);
    try {
      renameSync(tempPath, filePath);
      unlinkSync(backupPath);
    } catch (error) {
      try {
        renameSync(backupPath, filePath);
      } catch (restoreError) {
        throw new Error(
          `Atomic write failed and original restoration also failed: ${
            restoreError instanceof Error ? restoreError.message : String(restoreError)
          }`,
          { cause: error },
        );
      }
      throw error;
    }
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (cleanupError) {
      // No temporary file remains after a successful rename; cleanup is best effort.
      void cleanupError;
    }
  }
}
