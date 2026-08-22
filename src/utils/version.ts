import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Resolve this package's version by walking up from the given module's
 * directory until a package.json with our package name is found.
 * Shared single implementation (previously duplicated in cli.ts & health.ts).
 */
export function resolvePackageVersion(moduleDir: string): string {
  let dir = moduleDir;
  for (let i = 0; i < 5; i++) {
    try {
      const pkgPath = join(dir, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string };
      if (pkg.name === '@emirhanturker/projectmind') {
        return pkg.version ?? '0.0.0';
      }
    } catch {
      // Continue searching upward.
    }
    dir = dirname(dir);
  }
  return '0.0.0';
}

/** Convenience for ESM modules: derive dir from import.meta.url. */
export function currentModuleDir(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}
