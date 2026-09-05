/**
 * Centralized path utilities — cross-platform Windows/Linux/macOS helpers.
 *
 * All path strings returned by the knowledge graph and file system utilities
 * MUST use forward slashes (`/`) for portability. Use `normalizePath()` to
 * convert any input path to POSIX form before storing it.
 */

/**
 * Convert a path to POSIX form (forward slashes only).
 * Handles both Windows-style backslashes and mixed separators.
 *
 * @example
 * normalizePath('C:\\Users\\foo\\bar.ts')  // 'C:/Users/foo/bar.ts'
 * normalizePath('/home/foo/bar.ts')       // '/home/foo/bar.ts'
 * normalizePath('a\\b/c\\d')              // 'a/b/c/d'
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Normalize a path and ensure it doesn't end with a trailing slash,
 * except for filesystem roots like `/` or `C:/`.
 */
export function normalizePathNoTrailing(p: string): string {
  const normalized = normalizePath(p);
  if (normalized.length <= 1) return normalized;
  if (/^[A-Z]:\/$/.test(normalized)) return normalized;
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}
