import { isAbsolute, relative } from 'node:path';
import {
  assertProjectPath,
  PathSecurityError,
  validateProjectPath,
  type PathSecurityOptions,
  type PathSecurityResult,
} from '../../core/security/path-security.js';

export { assertProjectPath, PathSecurityError, validateProjectPath };
export type { PathSecurityOptions, PathSecurityResult };

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
  public readonly code = 'outside-project' as const;
  public readonly inputPath: string;
  public readonly projectRoot: string;

  constructor(filePath: string, projectRoot: string) {
    super(`Path escapes project root: "${filePath}" (project root: ${projectRoot})`);
    this.inputPath = filePath;
    this.projectRoot = projectRoot;
    this.name = 'PathEscapesProjectError';
  }
}

/**
 * Classify a user-supplied path by the convention it is written in,
 * independent of the host platform. Drive-letter (`C:\x`, `C:/x`) and UNC
 * (`\\server\share`, `//server/share`) paths are Windows-convention;
 * `/x` paths are POSIX-convention; everything else is relative.
 */
export function classifyPath(p: string): 'posix-absolute' | 'windows-absolute' | 'relative' {
  if (/^[A-Za-z]:/.test(p)) return 'windows-absolute';
  if (/^[\\/]{2}/.test(p)) return 'windows-absolute';
  if (p.startsWith('/')) return 'posix-absolute';
  return 'relative';
}

/**
 * K5: Confine a user-supplied path to the project boundary.
 *
 * Relative paths are resolved against `projectRoot`; absolute paths are
 * checked directly. A foreign-convention absolute path (e.g. `C:\...` on a
 * POSIX host or `/etc/...` on Windows) can never be inside the project root,
 * so it is rejected outright. Returns the ABSOLUTE in-project path (which is
 * safe to hand to readFileSync/analyzeSource afterwards) or throws
 * {@link PathEscapesProjectError}.
 */
export function confineToProject(filePath: string, projectRoot: string): string {
  try {
    // Preserve the legacy helper's ability to validate a project directory;
    // callers that read a file use the stricter `mustExist` contract directly.
    return assertProjectPath(filePath, projectRoot, { allowDirectory: true });
  } catch (error) {
    if (error instanceof PathSecurityError) {
      throw new PathEscapesProjectError(filePath, projectRoot);
    }
    throw error;
  }
}

/** CLI flags whose VALUE is a filesystem path (arrow hight-risk read/write). */
const PATH_VALUE_FLAGS = new Set([
  '-o',
  '--output',
  '-i',
  '--input',
  '--config',
  '--file',
  '--path',
  '--root',
  '-r',
  '--dir',
  '--target',
  '--output-dir',
  '--model-path',
  '--tsconfig',
  '--policy',
]);

/**
 * Validate CLI file arguments, including `--root`.
 *
 * `run_cli` pins the child process to the active project root.  A root flag
 * is therefore still a path-valued input: allowing it to escape here would
 * let a read-only bridge silently operate on another checkout. Direct CLI
 * callers may explicitly opt into another root; the CLI startup layer selects
 * that root as the new boundary. The MCP bridge always calls
 * confinePathValueFlags directly and never uses this exception.
 */
export function confineOutputPathFlags(
  argv: readonly string[],
  projectRoot: string,
  options: { allowRootOutsideProject?: boolean } = {},
): void {
  if (!options.allowRootOutsideProject) {
    confinePathValueFlags(argv, projectRoot);
    return;
  }

  // Trusted interactive bootstrap commands intentionally accept a new
  // project root. All other path-valued flags remain confined; the MCP
  // bridge never uses this escape hatch and always validates --root.
  const filtered: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    const equals = token.indexOf('=');
    const flag = equals === -1 ? token : token.slice(0, equals);
    if (flag === '--root' || flag === '-r') {
      const value = equals === -1 ? argv[index + 1] : token.slice(equals + 1);
      if (value === undefined || value.length === 0) {
        throw new PathSecurityError(
          'empty-path',
          value ?? '',
          projectRoot,
          'Provide a value for --root.',
        );
      }
      if (equals === -1) index++;
      continue;
    }
    filtered.push(token);
  }
  confinePathValueFlags(filtered, projectRoot);
}

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
    if (value === undefined || value.length === 0) {
      throw new PathSecurityError(
        'empty-path',
        value ?? '',
        projectRoot,
        `Provide a value for ${flag} inside the project root.`,
      );
    }
    confineToProject(value, projectRoot);
  }
}
