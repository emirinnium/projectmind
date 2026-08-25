import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Collect real license identifiers from installed packages under
 * node_modules (including @scope packages) by reading their package.json.
 *
 * Shared by `deps-fresh` and `license report` — both need the same
 * installed-license signal from disk (no fabricated values).
 */
export function collectInstalledLicenses(projectRoot: string): Map<string, string> {
  const licenses = new Map<string, string>();
  const nmRoot = join(projectRoot, 'node_modules');
  if (!existsSync(nmRoot)) return licenses;

  const readPkgLicense = (pkgDir: string): void => {
    const pkgJsonPath = join(pkgDir, 'package.json');
    if (!existsSync(pkgJsonPath)) return;
    try {
      const p = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { name?: string; license?: string | { type?: string } };
      if (!p.name) return;
      const lic = typeof p.license === 'string' ? p.license : typeof p.license === 'object' ? p.license?.type ?? '' : '';
      licenses.set(p.name, lic);
    } catch {
      // unreadable package.json: skip
    }
  };

  for (const entry of readdirSync(nmRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('@')) {
      const scopeDir = join(nmRoot, entry.name);
      for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
        if (sub.isDirectory()) readPkgLicense(join(scopeDir, sub.name));
      }
    } else {
      readPkgLicense(join(nmRoot, entry.name));
    }
  }
  return licenses;
}
