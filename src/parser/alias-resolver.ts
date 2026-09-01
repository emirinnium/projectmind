import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '../utils/config.js';

/**
 * Represents a single tsconfig path alias mapping.
 */
export interface AliasMapping {
  /** The alias prefix (e.g., '@/' or '@src/') */
  prefix: string;
  /** The resolved target paths (with wildcards stripped) */
  targets: string[];
}

/**
 * Result of resolving an import source through aliases.
 */
export interface AliasResolutionResult {
  /** Whether the source matched an alias */
  matched: boolean;
  /** The original source string */
  originalSource: string;
  /** The resolved candidate paths (project-relative) */
  resolvedCandidates: string[];
}

/**
 * AliasResolver loads and caches tsconfig.json path aliases, then resolves
 * bare import specifiers against them. This is used during scan to improve
 * import resolution rate by handling path aliases correctly.
 */
export class AliasResolver {
  private aliases: AliasMapping[] = [];
  private projectRoot: string;
  private loaded = false;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ?? loadConfig().projectRoot ?? process.cwd();
  }

  /**
   * Load aliases from tsconfig.json. Safe to call multiple times; only
   * performs the filesystem read once unless `forceReload` is true.
   */
  loadAliases(forceReload = false): AliasMapping[] {
    if (this.loaded && !forceReload) {
      return this.aliases;
    }

    this.aliases = [];
    this.loaded = true;

    const candidates = [
      join(this.projectRoot, 'tsconfig.json'),
      join(process.cwd(), 'tsconfig.json'),
    ];

    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        const content = readFileSync(candidate, 'utf-8');
        // Strip single-line comments before parsing
        const jsonText = content.replace(/^\s*\/\/.*$/gm, '');
        const tsconfig = JSON.parse(jsonText);
        const paths = tsconfig.compilerOptions?.paths;
        if (paths && typeof paths === 'object') {
          for (const [prefix, targetList] of Object.entries(paths)) {
            if (Array.isArray(targetList)) {
              this.aliases.push({
                prefix: prefix.replace(/\*$/, ''),
                targets: targetList.map((p) => (p as string).replace(/\*$/, '')),
              });
            }
          }
        }
        // Also check for baseUrl to resolve relative imports
        this.baseUrl = tsconfig.compilerOptions?.baseUrl;
        break;
      } catch {
        // Invalid JSON or no readable tsconfig - alias resolution stays off
      }
    }

    return this.aliases;
  }

  private baseUrl: string | undefined;

  /**
   * Get the configured baseUrl from tsconfig, if any.
   */
  getBaseUrl(): string | undefined {
    this.loadAliases();
    return this.baseUrl;
  }

  /**
   * Get the loaded alias mappings.
   */
  getAliases(): AliasMapping[] {
    return this.loadAliases();
  }

  /**
   * Check if a source string looks like it could be an alias-resolvable
   * import (i.e., it's not a relative import or a node: builtin).
   */
  isResolvable(source: string): boolean {
    if (source.startsWith('./') || source.startsWith('../') || source.startsWith('node:')) {
      return false;
    }
    return true;
  }

  /**
   * Resolve an import source against the configured aliases.
   *
   * Returns a result with `matched: true` and a list of candidate paths
   * (project-relative) if the source matches an alias prefix. The caller
   * should check the filesystem for each candidate to determine which one
   * exists.
   *
   * @param source The import source string (e.g., '@/components/Button')
   */
  resolveAlias(source: string): AliasResolutionResult {
    this.loadAliases();

    const result: AliasResolutionResult = {
      matched: false,
      originalSource: source,
      resolvedCandidates: [],
    };

    // Skip relative imports and node builtins
    if (!this.isResolvable(source)) {
      return result;
    }

    for (const alias of this.aliases) {
      if (source.startsWith(alias.prefix)) {
        const remainder = source.slice(alias.prefix.length);
        for (const target of alias.targets) {
          // Resolve target + remainder relative to the tsconfig location
          const candidate = join(target, remainder);
          result.resolvedCandidates.push(candidate);
        }
        result.matched = true;
        break;
      }
    }

    return result;
  }

  /**
   * Attempt to resolve an alias to an actual file path on disk.
   * Checks multiple extensions and index files.
   *
   * @param source The import source string
   * @param extensions Optional list of extensions to try (defaults to common TS/JS extensions)
   * @returns The resolved project-relative path, or null if not found
   */
  resolveAliasToPath(
    source: string,
    extensions: string[] = [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '/index.ts',
      '/index.tsx',
      '/index.js',
      '/index.jsx',
    ],
  ): string | null {
    const result = this.resolveAlias(source);
    if (!result.matched) return null;

    for (const candidate of result.resolvedCandidates) {
      const fullPath = resolve(this.projectRoot, candidate);

      // Try direct file match
      if (existsSync(fullPath)) {
        try {
          const stats = statSync(fullPath);
          if (stats.isFile()) {
            return candidate;
          }
        } catch {
          // ignore stat errors
        }
      }

      // Try with extensions
      for (const ext of extensions) {
        const withExt = fullPath + ext;
        if (existsSync(withExt)) {
          try {
            const stats = statSync(withExt);
            if (stats.isFile()) {
              return candidate + ext;
            }
          } catch {
            // ignore stat errors
          }
        }
      }
    }

    return null;
  }

  /**
   * Create a fresh resolver for the given file's directory.
   * Searches up the directory tree for tsconfig.json.
   */
  static forFile(filePath: string): AliasResolver {
    let dir = dirname(filePath);
    const root = loadConfig().projectRoot ?? process.cwd();

    // Walk up to find the nearest tsconfig.json
    while (dir.startsWith(root)) {
      if (existsSync(join(dir, 'tsconfig.json'))) {
        return new AliasResolver(dir);
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    return new AliasResolver(root);
  }
}

/** Singleton instance for reuse across the scanner */
let _defaultResolver: AliasResolver | null = null;

/**
 * Get the default alias resolver instance (cached).
 */
export function getDefaultAliasResolver(): AliasResolver {
  if (!_defaultResolver) {
    _defaultResolver = new AliasResolver();
  }
  return _defaultResolver;
}

/**
 * Reset the cached default resolver (useful for testing).
 */
export function resetDefaultAliasResolver(): void {
  _defaultResolver = null;
}
