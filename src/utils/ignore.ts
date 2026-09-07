import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { logger } from './logger.js';

/**
 * ProjectMind's built-in safety boundary for project-source discovery.
 *
 * User-specific exclusions live in `.pmignore`; `.projectmindrc.json` is
 * reserved for runtime configuration. Patterns use a gitignore-like syntax
 * without negation rules: blank lines and lines beginning with `#` are
 * ignored, and paths are always normalized to `/` separators.
 */
export const DEFAULT_PMIGNORE_PATTERNS = [
  'node_modules/**',
  'dist/**',
  'dist-tests/**',
  '.git/**',
  '.projectmind/**',
  '*.min.*',
  '*.map',
  '*.d.ts',
  'package-lock.json',
  'yarn.lock',
  '.next/**',
  '.turbo/**',
  'coverage/**',
  '.cache/**',
  'tmp/**',
  'temp/**',
  '.idea/**',
  'build/**',
  'out/**',
  'target/**',
  'vendor/**',
  '.kilo/**',
] as const;

export const DEFAULT_PMIGNORE_CONTENT = `# ProjectMind ignore rules (gitignore-style)
# Add generated, vendored, or sensitive paths that ProjectMind must not read.
node_modules/
dist/
dist-tests/
.git/
.projectmind/
coverage/
.cache/
tmp/
temp/
build/
out/
target/
vendor/
.kilo/
*.min.*
*.map
*.d.ts
package-lock.json
yarn.lock
`;

const PMIGNORE_FILENAME = '.pmignore';
const GLOB_REGEX_CACHE = new Map<string, RegExp>();

function normalizePattern(rawPattern: string): string | null {
  const trimmed = rawPattern.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (trimmed.startsWith('!')) {
    logger.warn(`Ignoring unsupported negation in .pmignore: ${rawPattern}`);
    return null;
  }

  const pattern = trimmed.replace(/^\/+/, '');
  if (!pattern) return null;
  if (pattern.endsWith('/')) return `**/${pattern}**`;
  return pattern.startsWith('**/') ? pattern : `**/${pattern}`;
}

/** Read user rules from the single supported ignore file at project root. */
export function readPmignore(projectRoot: string): string[] {
  const path = join(resolve(projectRoot), PMIGNORE_FILENAME);
  if (!existsSync(path)) return [];

  try {
    return readFileSync(path, 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map(normalizePattern)
      .filter((pattern): pattern is string => pattern !== null);
  } catch (error) {
    logger.warn(`Unable to read ${PMIGNORE_FILENAME} at ${path}; using built-in rules.`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** Return the complete normalized ignore list used by every source scanner. */
export function getProjectIgnorePatterns(projectRoot: string): string[] {
  return [
    ...new Set(
      [...DEFAULT_PMIGNORE_PATTERNS, ...readPmignore(projectRoot)].map((pattern) => {
        return normalizePattern(pattern) ?? pattern;
      }),
    ),
  ];
}

function globToRegExp(pattern: string): RegExp {
  const cached = GLOB_REGEX_CACHE.get(pattern);
  if (cached) return cached;

  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') {
        source += '(?:.*/)?';
        i++;
      } else {
        source += '.*';
      }
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += /[\\^$+?.()|{}[\]]/.test(char) ? `\\${char}` : char;
  }
  const expression = new RegExp(`${source}/?$`, 'i');
  GLOB_REGEX_CACHE.set(pattern, expression);
  return expression;
}

/** Test one project-relative path against normalized ProjectMind patterns. */
export function isIgnoredRelativePath(relativePath: string, patterns: readonly string[]): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../')) return false;
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

/** Test an absolute path against the project-root ignore boundary. */
export function isIgnoredPath(
  filePath: string,
  projectRoot: string,
  patterns = getProjectIgnorePatterns(projectRoot),
): boolean {
  const root = resolve(projectRoot);
  const absolute = resolve(filePath);
  if (isAbsolute(relative(root, absolute)) || relative(root, absolute).startsWith('..')) {
    return false;
  }
  return isIgnoredRelativePath(relative(root, absolute), patterns);
}
