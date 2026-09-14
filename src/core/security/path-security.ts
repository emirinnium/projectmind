import { existsSync, lstatSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, relative, resolve, dirname } from 'node:path';
import { getProjectIgnorePatterns, isIgnoredRelativePath } from '../../utils/ignore.js';
import { logger } from '../../utils/logger.js';

export type PathSecurityCode =
  | 'empty-path'
  | 'path-too-long'
  | 'nul-byte'
  | 'control-character'
  | 'foreign-absolute-path'
  | 'outside-project'
  | 'symlink-outside-project'
  | 'ignored-path'
  | 'not-a-file'
  | 'file-too-large';

export interface PathSecurityOptions {
  /** Existing files are required when a caller is about to read them. */
  mustExist?: boolean;
  /** Reject paths excluded by the single `.pmignore` policy. */
  rejectIgnored?: boolean;
  /** Permit a directory when the operation is a directory operation. */
  allowDirectory?: boolean;
  /** Maximum source size for a read operation. */
  maxBytes?: number;
}

export interface PathSecurityResult {
  absolutePath: string;
  relativePath: string;
  exists: boolean;
  stats?: Stats;
  ignored: boolean;
}

export class PathSecurityError extends Error {
  public readonly inputPath: string;
  public readonly projectRoot: string;

  constructor(
    public readonly code: PathSecurityCode,
    inputPath: string,
    projectRoot: string,
    nextAction: string,
  ) {
    super(
      `${code}: path "${redactPath(inputPath)}" is not allowed for project root "${redactPath(projectRoot)}". ${nextAction}`,
    );
    this.inputPath = inputPath;
    this.projectRoot = projectRoot;
    this.name = 'PathSecurityError';
  }
}

/** Normalize both separator conventions for policy checks without changing the filesystem path. */
function normalizeForComparison(value: string): string {
  return value.replace(/\\/g, '/');
}

function classifyConvention(value: string): 'posix' | 'windows' | 'relative' {
  if (/^[A-Za-z]:/.test(value) || /^[\\/]{2}/.test(value)) return 'windows';
  if (value.startsWith('/')) return 'posix';
  return 'relative';
}

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function redactPath(value: string): string {
  return value.replace(/[\r\n\0]/g, '�').slice(0, 512);
}

function nearestExistingPath(value: string): string {
  let current = value;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * Resolve and validate a user/repository-derived path against a trusted root.
 * The lexical check protects nonexistent output paths; the realpath check
 * protects existing symlinks/junctions from escaping the root.
 */
export function validateProjectPath(
  inputPath: string,
  projectRoot: string,
  options: PathSecurityOptions = {},
): PathSecurityResult {
  const root = resolve(projectRoot);
  if (!inputPath.trim()) {
    throw new PathSecurityError(
      'empty-path',
      inputPath,
      root,
      'Provide a non-empty relative path.',
    );
  }
  if (inputPath.length > 4096) {
    throw new PathSecurityError(
      'path-too-long',
      inputPath,
      root,
      'Use a path shorter than 4096 characters.',
    );
  }
  if (inputPath.includes('\0')) {
    throw new PathSecurityError('nul-byte', inputPath, root, 'Remove NUL bytes and retry.');
  }
  if ([...inputPath].some((char) => char.charCodeAt(0) < 0x20 && char !== '\t')) {
    throw new PathSecurityError(
      'control-character',
      inputPath,
      root,
      'Remove control characters from the path.',
    );
  }

  const convention = classifyConvention(inputPath);
  const hostConvention = process.platform === 'win32' ? 'windows' : 'posix';
  if (convention !== 'relative' && convention !== hostConvention) {
    throw new PathSecurityError(
      'foreign-absolute-path',
      inputPath,
      root,
      `Use a ${hostConvention} path or a project-relative path.`,
    );
  }

  // Treat either separator convention as a directory separator on every host.
  // This keeps project-relative paths copied from another OS portable while the
  // convention check above still rejects foreign absolute paths.
  const normalizedInputPath = normalizeForComparison(inputPath);
  const absolutePath = isAbsolute(normalizedInputPath)
    ? resolve(normalizedInputPath)
    : resolve(root, normalizedInputPath);
  if (!isInside(root, absolutePath)) {
    throw new PathSecurityError(
      'outside-project',
      inputPath,
      root,
      'Path escapes project root. Use a project-relative path inside the configured root.',
    );
  }

  const existingRoot = nearestExistingPath(root);
  const existingCandidate = nearestExistingPath(absolutePath);
  let canonicalRoot = root;
  let canonicalCandidate = existingCandidate;
  try {
    canonicalRoot = realpathSync.native(existingRoot);
    canonicalCandidate = realpathSync.native(existingCandidate);
  } catch (error) {
    // Lexical containment remains valid when the root is being created.
    logger.debug('Path realpath probe unavailable; using lexical containment.', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isInside(canonicalRoot, canonicalCandidate)) {
    throw new PathSecurityError(
      'symlink-outside-project',
      inputPath,
      root,
      'Remove the symlink/junction or point it to a location inside the project.',
    );
  }

  const relativePath = normalizeForComparison(relative(root, absolutePath));
  const ignored = isIgnoredRelativePath(relativePath, getProjectIgnorePatterns(root));
  if (ignored && options.rejectIgnored) {
    throw new PathSecurityError(
      'ignored-path',
      inputPath,
      root,
      'Remove the path from .pmignore only if it is intentionally project source.',
    );
  }

  const exists = existsSync(absolutePath);
  let stats: Stats | undefined;
  if (exists) {
    stats = lstatSync(absolutePath);
    if (!options.allowDirectory && !stats.isFile()) {
      throw new PathSecurityError(
        'not-a-file',
        inputPath,
        root,
        'Provide a regular file or enable directory access for this operation.',
      );
    }
    if (options.maxBytes !== undefined && stats.size > options.maxBytes) {
      throw new PathSecurityError(
        'file-too-large',
        inputPath,
        root,
        `Use a file no larger than ${options.maxBytes} bytes or narrow the requested range.`,
      );
    }
  } else if (options.mustExist) {
    throw new PathSecurityError(
      'not-a-file',
      inputPath,
      root,
      'Run scan or create the file before requesting it.',
    );
  }

  return { absolutePath, relativePath, exists, stats, ignored };
}

export function assertProjectPath(
  inputPath: string,
  projectRoot: string,
  options: PathSecurityOptions = {},
): string {
  return validateProjectPath(inputPath, projectRoot, options).absolutePath;
}
