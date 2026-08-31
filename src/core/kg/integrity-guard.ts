/**
 * Knowledge Graph Integrity Guard.
 *
 * Detects and repairs drift between the knowledge graph and the real
 * filesystem / git history:
 *  - missing & moved files (git rename chasing + bounded FS fallback)
 *  - stale imports (resolved against the IMPORTING file's directory)
 *  - stale functions (AST check: DB rows vs actually parsed functions)
 *  - orphan files & orphan functions (never exported, never called,
 *    never referenced by an import)
 *
 * Every violation carries spec fields (F23): kgNodeId, suggestedAction,
 * confidence, plus structured data so repairs never parse message strings.
 */
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { getDatabase } from '../../storage/database.js';
import { parseFile } from '../../parser/ast-parser.js';
import type { IntegrityViolation, IntegrityReport } from './types.js';

/** Directories the filesystem fallback never enters (F26). */
export const INTEGRITY_EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  'build',
  'out',
  '.cache',
  '.vscode',
  '.idea',
  'tmp',
  'temp',
]);

/** Fallback search bounds (F26). */
const FS_SEARCH_MAX_DEPTH = 6;
const FS_SEARCH_MAX_CANDIDATES = 5000;
/** Cap for git rename chasing to avoid pathological loops. */
const MAX_RENAME_HOPS = 10;

/** Extensions tried when resolving relative import specifiers (F27). */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.jsx'];

/** Timeout (ms) for git commands used during integrity checks. */
const DEFAULT_INTEGRITY_TIMEOUT_MS = 5000;

export interface ParsedRenameLog {
  /** Final path after applying every chained rename, or null when none. */
  path: string | null;
  /** True when the tracked path was deleted (no rename resolved it). */
  deleted: boolean;
  /** Commit hash where the deletion was observed (for follow-up inspection). */
  deletedAtCommit?: string;
}

function normalizePosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Parse `git log --follow --name-status --format=%H -- <path>` output.
 *
 * The output is NEWEST-FIRST: commit hash lines followed by name-status lines
 * (`R###\tfrom\tto`, `D\tpath`, `A\tpath`, `M\tpath`). Starting from
 * `startPath`, the newest rename whose `from` matches the current search path
 * is taken, then older entries chain multi-hop renames (an older entry's
 * `from` equals the previous entry's `to`). A `D` for the tracked path marks
 * deletion (F46): real git reports renames of an OLD name as `D` because the
 * rename target is filtered out — the caller can inspect the recorded commit
 * to recover the target.
 */
export function parseGitRenameLog(output: string, startPath: string): ParsedRenameLog {
  let current = normalizePosix(startPath);
  let progress = false;
  let deleted = false;
  let deletedAtCommit: string | undefined;
  let currentCommit: string | undefined;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (/^[0-9a-f]{7,40}$/i.test(line.trim())) {
      currentCommit = line.trim();
      continue;
    }
    const parts = line.split('\t');
    const status = parts[0];
    if (/^R\d*$/.test(status) && parts.length >= 3) {
      const from = normalizePosix(parts[1]);
      const to = normalizePosix(parts[2]);
      if (from === current) {
        current = to;
        progress = true;
        deleted = false; // renamed, not deleted
      }
    } else if (status === 'D' && parts.length >= 2) {
      const path = normalizePosix(parts[1]);
      if (path === current) {
        // Newest-first: the first D for the tracked path is the commit where
        // it disappeared (rename or delete). Older history is irrelevant.
        deleted = true;
        deletedAtCommit = currentCommit;
        break;
      }
    }
    // A/M/other lines carry no move information.
  }

  if (deleted) return { path: null, deleted: true, deletedAtCommit };
  return { path: progress ? current : null, deleted: false };
}

export class IntegrityGuard {
  private root: string;

  constructor(root = process.cwd()) {
    this.root = root;
  }

  /**
   * Check consistency of the knowledge graph against the filesystem
   * and git history.
   */
  checkConsistency(): IntegrityViolation[] {
    const violations: IntegrityViolation[] = [];
    const db = getDatabase();
    const missingPaths = new Set<string>();

    // 1. Missing / moved files
    const fileRows = db
      .prepare('SELECT id, relative_path FROM files')
      .all() as Array<{ id: number; relative_path: string }>;

    for (const row of fileRows) {
      const fullPath = join(this.root, row.relative_path);
      if (!existsSync(fullPath)) {
        missingPaths.add(row.relative_path);
        const moved = this.detectMovedFile(row.relative_path);
        if (moved) {
          violations.push({
            type: 'moved_file',
            filePath: row.relative_path,
            message: `File moved to ${moved}`,
            suggestedPath: moved,
            kgNodeId: row.id,
            suggestedAction: 'update_path',
            confidence: 0.9,
          });
        } else {
          violations.push({
            type: 'missing_file',
            filePath: row.relative_path,
            message: `File missing at ${row.relative_path}`,
            kgNodeId: row.id,
            suggestedAction: 'delete_node',
            confidence: 0.9,
          });
        }
      }
    }

    // 2. F24 — AST function-existence check: DB function rows vs functions
    // actually present in the current file content. Skips missing files.
    for (const row of fileRows) {
      if (missingPaths.has(row.relative_path)) continue;
      const fnRows = db
        .prepare('SELECT id, name FROM functions WHERE file_id = ?')
        .all(row.id) as Array<{ id: number; name: string }>;
      if (fnRows.length === 0) continue;

      const fullPath = join(this.root, row.relative_path);
      let parsedNames: Set<string> | null = null;
      try {
        const structure = parseFile(fullPath);
        if (structure) {
          parsedNames = new Set(structure.functions.map((f) => f.name));
        }
      } catch {
        parsedNames = null; // unparseable — cannot judge, skip
      }
      if (!parsedNames) continue;

      for (const fn of fnRows) {
        if (!parsedNames.has(fn.name)) {
          violations.push({
            type: 'stale_function',
            filePath: row.relative_path,
            message: `Function '${fn.name}' no longer exists in ${row.relative_path}`,
            kgNodeId: fn.id,
            suggestedAction: 'delete_node',
            confidence: 0.95,
            functionName: fn.name,
            details: { functionName: fn.name, fileId: row.id },
          });
        }
      }
    }

    // 3. Stale imports (unresolved) — carry structured data (F27).
    const staleImports = db
      .prepare(
        `SELECT i.id AS import_id, i.file_id AS file_id, f.relative_path AS file, i.source AS src
         FROM imports i
         JOIN files f ON f.id = i.file_id
         WHERE i.resolved = 0`
      )
      .all() as Array<{ import_id: number; file_id: number; file: string; src: string }>;

    for (const s of staleImports) {
      violations.push({
        type: 'stale_import',
        filePath: s.file,
        message: `Unresolved import ${s.src}`,
        kgNodeId: s.import_id,
        suggestedAction: 'relink',
        confidence: 0.8,
        sourcePath: s.file,
        specifier: s.src,
        details: { fileId: s.file_id, specifier: s.src },
      });
    }

    // 4. Orphan nodes (files with zero connections)
    const orphans = this.detectOrphansWithIds();
    for (const o of orphans) {
      violations.push({
        type: 'orphan_node',
        filePath: o.relativePath,
        message: `Orphan node: no imports or references`,
        kgNodeId: o.id,
        suggestedAction: 'delete_node',
        confidence: 0.5,
      });
    }

    // 5. F28 — Orphan functions: NOT exported AND zero call edges AND zero
    // import references. Function name lives in functionName/details, never
    // in filePath.
    violations.push(...this.detectOrphanFunctionViolations(missingPaths));

    return violations;
  }

  /**
   * Repair stale nodes by updating DB paths, resolving imports and deleting
   * stale function rows. Returns number of repaired nodes.
   */
  repairStaleNodes(violations?: IntegrityViolation[]): number {
    const vios = violations ?? this.checkConsistency();
    const db = getDatabase();
    let repaired = 0;

    for (const v of vios) {
      if (v.type === 'moved_file' && v.suggestedPath) {
        db.prepare('UPDATE files SET relative_path = ? WHERE id = ?').run(v.suggestedPath, v.kgNodeId);
        repaired++;
      } else if (v.type === 'stale_import') {
        // F27: resolve against the IMPORTING file's directory using the
        // structured specifier — never reconstruct from the message string.
        const specifier = v.specifier ?? this.extractSpecifier(v);
        if (!specifier) continue;
        const importId =
          typeof v.kgNodeId === 'number'
            ? v.kgNodeId
            : (
                db
                  .prepare(
                    `SELECT i.id FROM imports i JOIN files f ON f.id = i.file_id
                     WHERE f.relative_path = ? AND i.source = ? AND i.resolved = 0`
                  )
                  .get(v.sourcePath ?? v.filePath, specifier) as { id: number } | undefined
              )?.id;
        if (importId === undefined) continue;

        const resolvedRel = this.resolveRelativeImport(v.sourcePath ?? v.filePath, specifier);
        if (resolvedRel) {
          // F27: set BOTH resolved=1 AND resolved_path.
          db.prepare('UPDATE imports SET resolved = 1, resolved_path = ? WHERE id = ?').run(
            resolvedRel,
            importId
          );
          repaired++;
        }
      } else if (v.type === 'stale_function') {
        db.prepare('DELETE FROM functions WHERE id = ?').run(v.kgNodeId);
        repaired++;
      }
    }

    return repaired;
  }

  /**
   * F28: orphan function detection.
   * Flags functions that are NOT exported AND have zero call edges AND zero
   * import references. Export info is not stored in the schema, so it is
   * derived from the AST when parseable (confidence 0.85) and approximated
   * via an `export` keyword content check otherwise (confidence 0.6).
   */
  detectOrphanFunctionViolations(missingPaths?: Set<string>): IntegrityViolation[] {
    const db = getDatabase();
    const missing = missingPaths ?? new Set<string>();
    const rows = db
      .prepare(
        `SELECT fn.id AS fn_id, fn.name AS name, fn.file_id AS file_id, f.relative_path AS rel
         FROM functions fn
         JOIN files f ON f.id = fn.file_id
         WHERE NOT EXISTS (SELECT 1 FROM calls c WHERE c.from_function_id = fn.id)
           AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.to_function_id = fn.id)
           AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.source LIKE '%' || fn.name || '%')`
      )
      .all() as Array<{ fn_id: number; name: string; file_id: number; rel: string }>;

    const violations: IntegrityViolation[] = [];
    const parseCache = new Map<string, ReturnType<typeof parseFile> | undefined>();

    for (const row of rows) {
      if (missing.has(row.rel)) continue; // already reported as missing file
      const fullPath = join(this.root, row.rel);

      let exported: boolean | undefined;
      let confidence = 0.6;
      let approximated = true;

      let structure = parseCache.get(row.rel);
      if (!parseCache.has(row.rel)) {
        try {
          structure = parseFile(fullPath);
        } catch {
          structure = undefined;
        }
        parseCache.set(row.rel, structure);
      }
      const fnInfo = structure?.functions.find((f) => f.name === row.name);
      if (fnInfo) {
        exported = fnInfo.isExported;
        confidence = 0.85; // AST-derived, but export info is not in the schema
        approximated = false;
      } else {
        // Content-check approximation: `export` keyword before declaration.
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const re = new RegExp(
            `export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\s+${escapeRegExp(row.name)}\\b|(?:const|let|var)\\s+${escapeRegExp(row.name)}\\b)`
          );
          exported = re.test(content);
        } catch {
          exported = false;
        }
      }

      if (exported) continue; // exported functions are never orphans

      violations.push({
        type: 'orphan_node',
        filePath: row.rel, // the file containing it — never the function name
        message: `Orphan function '${row.name}': not exported, no calls, no import references`,
        kgNodeId: row.fn_id,
        suggestedAction: 'delete_node',
        confidence,
        functionName: row.name,
        details: {
          functionName: row.name,
          fileId: row.file_id,
          exported: false,
          approximated,
        },
      });
    }

    return violations;
  }

  /**
   * Detect orphan functions: functions with zero calls entries (from and to).
   * Kept for backwards compatibility; prefer detectOrphanFunctionViolations.
   */
  detectOrphanFunctions(): string[] {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT f.name FROM functions f
         WHERE NOT EXISTS (SELECT 1 FROM calls c WHERE c.from_function_id = f.id)
          AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.to_function_id = f.id)`
      )
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /**
   * Detect orphan nodes: files with no import connections.
   */
  detectOrphans(): string[] {
    return this.detectOrphansWithIds().map((o) => o.relativePath);
  }

  private detectOrphansWithIds(): Array<{ id: number; relativePath: string }> {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT f.id, f.relative_path FROM files f
         WHERE NOT EXISTS (
           SELECT 1 FROM imports i WHERE i.file_id = f.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM imports i WHERE i.source LIKE '%' || f.relative_path || '%'
         )`
      )
      .all() as Array<{ id: number; relative_path: string }>;
    return rows.map((r) => ({ id: r.id, relativePath: r.relative_path }));
  }

  /**
   * F46/F25: detect if a file moved.
   *
   * 1. `git log --follow --name-status --format=%H -- <oldPath>` (newest
   *    first). Rename lines are chained (parseGitRenameLog). Real git reports
   *    a rename of an OLD tracked name as `D` (the target is filtered out),
   *    so when a deletion is seen we inspect that commit's full diff
   *    (`git show --name-status`) to recover the rename target, then keep
   *    chasing newer names (multi-hop). If the file was truly deleted in
   *    HEAD, returns null and the violation stays `missing_file`.
   * 2. Fallback: bounded filesystem search (F26) — never enters excluded
   *    directories (node_modules, .git, dist, ... or any dot-directory),
   *    capped in depth/candidates, preferring matches under src/.
   */
  detectMovedFile(originalPath: string): string | null {
    const start = normalizePosix(originalPath);
    let current = start;
    let gitAnswered = false;

    for (let hop = 0; hop < MAX_RENAME_HOPS; hop++) {
      let out: string;
      try {
        out = execFileSync('git', ['log', '--follow', '--name-status', '--format=%H', '--', current], {
          cwd: this.root,
          encoding: 'utf-8',
          maxBuffer: 4 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: DEFAULT_INTEGRITY_TIMEOUT_MS,
        });
      } catch {
        break; // not a git repo / git missing — fall through to FS search
      }
      gitAnswered = true;

      const parsed = parseGitRenameLog(out, current);
      if (parsed.path && parsed.path !== current) {
        current = parsed.path;
        if (existsSync(join(this.root, current))) return current; // verified on disk
        continue; // keep chasing: the new name may have moved again
      }
      if (parsed.deleted && parsed.deletedAtCommit) {
        const target = this.resolveRenameInCommit(parsed.deletedAtCommit, current);
        if (target) {
          current = target;
          if (existsSync(join(this.root, current))) return current;
          continue;
        }
        return null; // deleted in HEAD — no FS fallback, violation stays missing_file
      }
      break; // git has no move information for this path
    }

    if (gitAnswered && current !== start && existsSync(join(this.root, current))) {
      return current;
    }

    // 2. Filesystem fallback (also used when git is unavailable).
    return this.filesystemSearch(start);
  }

  /** Inspect a commit's full diff for a rename whose source is `path`. */
  private resolveRenameInCommit(commitHash: string, path: string): string | null {
    try {
      const out = execFileSync('git', ['show', '--name-status', '--format=', commitHash], {
        cwd: this.root,
        encoding: 'utf-8',
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: DEFAULT_INTEGRITY_TIMEOUT_MS,
      });
      for (const rawLine of out.split(/\r?\n/)) {
        const parts = rawLine.trimEnd().split('\t');
        if (/^R\d*$/.test(parts[0]) && parts.length >= 3 && normalizePosix(parts[1]) === path) {
          return normalizePosix(parts[2]);
        }
      }
    } catch {
      // ignore — treated as pure deletion
    }
    return null;
  }

  /**
   * F26: bounded recursive filesystem search for a file with the same
   * basename. Excludes node_modules/.git/dist/coverage/build/out/.cache/
   * .vscode/.idea/tmp/temp and ALL dot-directories, caps recursion depth and
   * total visited entries, and prefers matches under src/. Never returns a
   * path inside an excluded directory.
   */
  filesystemSearch(originalPath: string): string | null {
    const basename = originalPath.split('/').pop() ?? originalPath;
    const candidates: string[] = [];
    let visited = 0;
    const stack: Array<{ dir: string; depth: number }> = [{ dir: this.root, depth: 0 }];

    while (stack.length > 0 && visited < FS_SEARCH_MAX_CANDIDATES) {
      const { dir, depth } = stack.pop()!;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (++visited > FS_SEARCH_MAX_CANDIDATES) break;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth + 1 > FS_SEARCH_MAX_DEPTH) continue;
          if (INTEGRITY_EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
          stack.push({ dir: full, depth: depth + 1 });
        } else if (entry.isFile() && entry.name === basename) {
          const rel = normalizePosix(relative(this.root, full));
          if (rel === originalPath) continue;
          const segments = rel.split('/');
          if (segments.some((s) => INTEGRITY_EXCLUDED_DIRS.has(s) || s.startsWith('.'))) continue;
          candidates.push(rel);
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const aSrc = a.startsWith('src/') ? 0 : 1;
      const bSrc = b.startsWith('src/') ? 0 : 1;
      if (aSrc !== bSrc) return aSrc - bSrc;
      const aDepth = a.split('/').length;
      const bDepth = b.split('/').length;
      if (aDepth !== bDepth) return aDepth - bDepth;
      return a.localeCompare(b);
    });
    return candidates[0];
  }

  /**
   * F27: resolve a relative import specifier against the importing file's
   * directory. Returns the resolved project-relative path or null.
   */
  resolveRelativeImport(importerRelPath: string, specifier: string): string | null {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      return null; // bare package imports are not filesystem-resolvable here
    }
    const importerDir = dirname(join(this.root, importerRelPath));
    const base = resolve(importerDir, specifier);
    // Never resolve outside the project root or into excluded directories.
    const rootResolved = resolve(this.root);
    if (base !== rootResolved && !base.startsWith(rootResolved + sep)) return null;

    const stripped = base.replace(/\.(ts|tsx|js|mjs|jsx)$/, '');
    const candidates: string[] = [base];
    for (const ext of RESOLVE_EXTENSIONS) {
      candidates.push(stripped + ext);
      candidates.push(join(stripped, `index${ext}`));
    }

    for (const cand of candidates) {
      const rel = normalizePosix(relative(this.root, cand));
      if (rel.startsWith('..')) continue;
      if (rel.split('/').some((s) => INTEGRITY_EXCLUDED_DIRS.has(s) || s.startsWith('.'))) continue;
      try {
        if (existsSync(cand) && statSync(cand).isFile()) {
          return rel;
        }
      } catch {
        // ignore unreadable candidates
      }
    }
    return null;
  }

  /**
   * Schedule periodic integrity checks. F29: the callback is wrapped in
   * try/catch so a failing check never kills the schedule, and the timer is
   * unref'd so it never keeps the process alive.
   */
  scheduleCheck(intervalMs: number): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      try {
        this.checkConsistency();
      } catch {
        // keep the schedule alive; next tick may succeed
      }
    }, intervalMs);
    timer.unref?.();
    return timer;
  }

  /**
   * Generate a full integrity report. F29: checkConsistency runs ONCE and
   * the result is reused for repair and orphan reporting.
   */
  generateReport(): IntegrityReport {
    const violations = this.checkConsistency();
    const repaired = this.repairStaleNodes(violations);
    const orphans = violations
      .filter((v) => v.type === 'orphan_node')
      .map((v) => (v.functionName ? `${v.filePath}#${v.functionName}` : v.filePath));
    return {
      violations,
      repaired,
      orphans,
      timestamp: new Date().toISOString(),
    };
  }

  /** Backwards-compat helper: specifier from legacy message format. */
  private extractSpecifier(v: IntegrityViolation): string | undefined {
    const m = /^Unresolved import (.+)$/.exec(v.message);
    return m ? m[1] : undefined;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
