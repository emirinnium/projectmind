import { isAbsolute, relative, resolve } from 'node:path';

/**
 * True when `candidate` is `parent` itself or strictly inside it.
 * Both paths should be absolute; `relative()` handles the boundary check
 * without path-string normalization pitfalls (case/drive/sep differences).
 */
export function isPathInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Thrown when a user-supplied path (K5: file tools; K4: path-valued CLI
 * flags) would escape the project root. Callers should surface `message`
 * to the agent verbatim — the path is echoed, never followed.
 */
export class PathEscapesProjectError extends Error {
  constructor(filePath: string, projectRoot: string) {
    super(`Path escapes project root: "${filePath}" (project root: ${projectRoot})`);
    this.name = 'PathEscapesProjectError';
  }
}

/**
 * K5: Confine a user-supplied path to the project boundary.
 *
 * Relative paths are resolved against `projectRoot`; absolute paths are
 * checked directly. Returns the ABSOLUTE in-project path (which is safe to
 * hand to readFileSync/analyzeSource afterwards) or throws
 * {@link PathEscapesProjectError}.
 */
export function confineToProject(filePath: string, projectRoot: string): string {
  const abs = isAbsolute(filePath) ? filePath : resolve(projectRoot, filePath);
  if (!isPathInside(projectRoot, abs)) {
    throw new PathEscapesProjectError(filePath, projectRoot);
  }
  return abs;
}

/** CLI flags whose VALUE is a filesystem path (arrow hight-risk read/write). */
const PATH_VALUE_FLAGS = new Set(['-o', '--output', '-i', '--input', '--config', '--file', '--path']);

/**
 * K4: Reject path-valued CLI flags whose value would read/write OUTSIDE the
 * project boundary.
 *
 * CLI children spawned by runCliCapture run with cwd pinned to the project
 * root, so a `../`-relative or absolute escape (e.g. `-o C:\Users\evil\x`)
 * would silently hit arbitrary user files. This helper validates BOTH the
 * space-separated form (`-o x.json`) and the `--output=x.json` form for every
 * allowlisted/path-valued flag. Leaves `argv` untouched when safe.
 *
 * @throws {PathEscapesProjectError} on the first escaping path value.
 */
export function confinePathValueFlags(argv: readonly string[], projectRoot: string): void {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (!PATH_VALUE_FLAGS.has(flag)) continue;
    const value = eq === -1 ? argv[i + 1] : token.slice(eq + 1);
    if (value === undefined || value.length === 0) continue;
    confineToProject(value, projectRoot);
  }
}