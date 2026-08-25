import { Command } from 'commander';
import { asyncHandler, output } from '@/cli/utils/shared.js';
import { loadConfig } from '@/cli/utils/shared.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface PackageInfo {
  dir: string;
  name: string;
  version: string;
  private?: boolean;
  deps: Record<string, string>;
}

/**
 * Monorepo/workspace analysis: discovers pnpm/npm/yarn workspaces (and notes
 * Nx/Turbo), maps internal package-to-package dependency edges from declared
 * dependencies, and sanity-checks ranges against actual versions.
 */
export function createWorkspaceCommand(): Command {
  return new Command('workspace')
    .description('Analyze monorepo workspaces: packages, internal dependency edges, range mismatches')
    .option('--format <fmt>', 'Output: text|json', 'text')
    .action(asyncHandler(async (opts: { format: string }) => {
      const root = loadConfig().projectRoot;

      // ---- Discovery -----------------------------------------------------
      const globs: string[] = [];
      let manager = 'none';

      const pnpmWs = join(root, 'pnpm-workspace.yaml');
      if (existsSync(pnpmWs)) {
        manager = 'pnpm';
        const yaml = readFileSync(pnpmWs, 'utf-8');
        let inPackages = false;
        for (const line of yaml.split(/\r?\n/)) {
          if (/^packages\s*:/.test(line)) { inPackages = true; continue; }
          if (inPackages) {
            const m = /^\s*-\s*(.+?)\s*$/.exec(line);
            if (m) globs.push(m[1].replace(/['"]/g, ''));
            else if (/^\S/.test(line)) inPackages = false;
          }
        }
      }

      const rootPkgPath = join(root, 'package.json');
      let rootName = '';
      if (existsSync(rootPkgPath)) {
        const pkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
        rootName = pkg.name ?? '';
        const ws = pkg.workspaces;
        if (Array.isArray(ws)) { globs.push(...ws); if (manager === 'none') manager = ws.length > 0 ? 'npm/yarn' : manager; }
        else if (ws && Array.isArray(ws.packages)) { globs.push(...ws.packages); if (manager === 'none') manager = 'yarn'; }
      }

      if (existsSync(join(root, 'nx.json'))) output.info('Nx detected (nx.json present)');
      if (existsSync(join(root, 'turbo.json'))) output.info('Turborepo detected (turbo.json present)');

      // Expand simple glob patterns (dir/*, exact paths).
      const packages: PackageInfo[] = [];
      const seenDirs = new Set<string>();
      for (const pattern of globs) {
        const base = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
        if (base.includes('*')) {
          const parentDir = base.split('/')[0];
          const parentPath = join(root, parentDir);
          if (!existsSync(parentPath)) continue;
          for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            collectPackage(join(parentPath, entry.name));
          }
        } else {
          collectPackage(join(root, base));
        }
      }

      function collectPackage(dir: string): void {
        const pkgPath = join(dir, 'package.json');
        if (!existsSync(pkgPath) || seenDirs.has(dir)) return;
        seenDirs.add(dir);
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string; private?: boolean; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
          if (!pkg.name) return;
          packages.push({
            dir: dir.slice(root.length + 1).replace(/\\/g, '/'),
            name: pkg.name,
            version: pkg.version ?? '0.0.0',
            private: pkg.private,
            deps: { ...pkg.dependencies, ...pkg.devDependencies },
          });
        } catch { /* unreadable package.json — skip */ }
      }

      if (packages.length === 0) {
        output.warn(`No workspace packages discovered (manager: ${manager}). This does not look like a monorepo.`);
        return;
      }

      // ---- Internal edges + range checks ---------------------------------
      const byName = new Map(packages.map((p) => [p.name, p]));
      interface Edge { from: PackageInfo; to: PackageInfo; range: string; status: 'ok' | 'mismatch' | 'unknown-range'; }
      const edges: Edge[] = [];
      for (const pkg of packages) {
        for (const [depName, range] of Object.entries(pkg.deps)) {
          const target = byName.get(depName);
          if (!target || target === pkg) continue;
          edges.push({ from: pkg, to: target, range, status: checkRange(range, target.version) });
        }
      }

      const result = {
        manager,
        rootPackage: rootName,
        packageCount: packages.length,
        packages: packages.map(({ dir, name, version, private: isPrivate }) => ({ dir, name, version, private: !!isPrivate })),
        internalEdges: edges.map((e) => ({ from: e.from.name, to: e.to.name, range: e.range, status: e.status })),
      };

      if (opts.format === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      output.section(`Workspace (${manager}) — ${rootName}`);
      output.section(`Packages (${packages.length})`);
      for (const p of packages) {
        output.kv(`  ${p.dir}`, `${p.name}@${p.version}${p.private ? ' (private)' : ''}`);
      }

      output.section(`Internal Dependency Edges (${edges.length})`);
      for (const e of edges.sort((a, b) => a.from.name.localeCompare(b.from.name))) {
        const icon = e.status === 'ok' ? '✓' : e.status === 'mismatch' ? '⚠️' : '?';
        output.kv(`  ${icon} ${e.from.name} → ${e.to.name}`, `range: ${e.range} | installed: ${e.to.version}`);
      }

      const mismatches = edges.filter((e) => e.status === 'mismatch');
      if (mismatches.length > 0) {
        output.section(`Range Mismatches (${mismatches.length})`);
        for (const e of mismatches) {
          output.warn(`${e.from.name} declares ${e.to.name}@${e.range} but installed version is ${e.to.version}`);
        }
      }
    })
  );
}

/** Minimal semver sanity check for ^ / ~ / exact ranges (no external dep). */
function checkRange(range: string, actualVersion: string): 'ok' | 'mismatch' | 'unknown-range' {
  const clean = range.trim().replace(/^workspace:/, '');
  const m = /^(\^|~)?(\d+)\.(\d+)(\.\d+)?/.exec(clean);
  if (!m) return 'unknown-range';
  const [, caret, major, minor] = m;
  const am = /^(\d+)\.(\d+)/.exec(actualVersion);
  if (!am) return 'unknown-range';
  if (caret === '^') return am[1] === major ? 'ok' : 'mismatch';
  if (caret === '~') return am[1] === major && am[2] === minor ? 'ok' : 'mismatch';
  return clean.startsWith(actualVersion) ? 'ok' : 'mismatch';
}
