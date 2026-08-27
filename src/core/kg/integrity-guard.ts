import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { getDatabase } from '../../storage/database.js';
import type {
  IntegrityViolation,
  IntegrityReport,
} from './types.js';

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

    // 1. Missing / moved files
    const fileRows = db
      .prepare('SELECT id, relative_path FROM files')
      .all() as Array<{ id: number; relative_path: string }>;

    for (const row of fileRows) {
      const fullPath = join(this.root, row.relative_path);
      if (!existsSync(fullPath)) {
        const moved = this.detectMovedFile(row.relative_path);
        if (moved) {
          violations.push({
            type: 'moved_file',
            filePath: row.relative_path,
            message: `File moved to ${moved}`,
            suggestedPath: moved,
          });
        } else {
          violations.push({
            type: 'missing_file',
            filePath: row.relative_path,
            message: `File missing at ${row.relative_path}`,
          });
        }
      }
    }

    // 2. Stale imports (unresolved)
    const staleImports = db
      .prepare(
        `SELECT f.relative_path AS file, i.source AS src
         FROM imports i
         JOIN files f ON f.id = i.file_id
         WHERE i.resolved = 0`
      )
      .all() as Array<{ file: string; src: string }>;

    for (const s of staleImports) {
      violations.push({
        type: 'stale_import',
        filePath: s.file,
        message: `Unresolved import ${s.src}`,
      });
    }

    // 3. Orphan nodes (files with zero connections)
    const orphans = this.detectOrphans();
    for (const o of orphans) {
      violations.push({
        type: 'orphan_node',
        filePath: o,
        message: `Orphan node: no imports or references`,
      });
    }

    return violations;
  }

  /**
   * Repair stale nodes by updating DB paths and resolving imports.
   * Returns number of repaired nodes.
   */
  repairStaleNodes(): number {
    const violations = this.checkConsistency();
    const db = getDatabase();
    let repaired = 0;

    for (const v of violations) {
      if (v.type === 'moved_file' && v.suggestedPath) {
        db
          .prepare('UPDATE files SET relative_path = ? WHERE relative_path = ?')
          .run(v.suggestedPath, v.filePath);
        repaired++;
      } else if (v.type === 'stale_import') {
        // Attempt to resolve relative import by checking filesystem
        const fileRow = db
          .prepare('SELECT id FROM files WHERE relative_path = ?')
          .get(v.filePath) as { id: number } | undefined;
        if (fileRow) {
          const importRow = db
            .prepare('SELECT id FROM imports WHERE file_id = ? AND source = ? AND resolved = 0')
            .get(fileRow.id, v.message.replace('Unresolved import ', '')) as { id: number } | undefined;
          if (importRow) {
            // Try to find target file with common extensions
            const src = v.message.replace('Unresolved import ', '');
            const base = src.replace(/\.(ts|js|tsx|jsx)$/, '');
            const candidates = [`${base}.ts`, `${base}.js`, `${base}.tsx`, `${base}.jsx`];
            for (const cand of candidates) {
              const targetPath = join(this.root, cand);
              if (existsSync(targetPath)) {
                db
                  .prepare('UPDATE imports SET resolved = 1 WHERE id = ?')
                  .run(importRow.id);
                repaired++;
                break;
              }
            }
          }
        }
      }
    }

    return repaired;
  }

  /**
   * Detect orphan nodes: files with no import connections.
   */
  detectOrphans(): string[] {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT f.relative_path FROM files f
         WHERE NOT EXISTS (
           SELECT 1 FROM imports i WHERE i.file_id = f.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM imports i WHERE i.source LIKE '%' || f.relative_path || '%'
         )`
      )
      .all() as Array<{ relative_path: string }>;
    return rows.map((r) => r.relative_path);
  }

  /**
   * Use git log --follow to detect if a file has been moved.
   */
  private detectMovedFile(originalPath: string): string | null {
    try {
      // Try to find current path via git log --follow --diff-filter=R
      const out = execSync(
        `git log --follow --pretty=format: --name-only --diff-filter=R -- "${originalPath}"`,
        { cwd: this.root, encoding: 'utf-8', maxBuffer: 1024 * 1024 }
      );
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      // The last line after rename is typically the new path
      if (lines.length > 0) {
        const last = lines[lines.length - 1];
        if (last && last !== originalPath && existsSync(join(this.root, last))) {
          return last;
        }
      }
    } catch {
      // Not a git repo or file never tracked
    }

    // Fallback: search filesystem for file with same basename
    try {
      const basename = originalPath.split('/').pop() ?? originalPath;
      const out = execSync(`find . -name "${basename}" -type f 2>/dev/null | head -n 1`, {
        cwd: this.root,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
      const found = out.trim();
      if (found && found !== originalPath && existsSync(join(this.root, found))) {
        return found.replace(/^\.\//, '');
      }
    } catch {
      // ignore
    }

    return null;
  }

  /**
   * Generate a full integrity report.
   */
  generateReport(): IntegrityReport {
    const violations = this.checkConsistency();
    const repaired = this.repairStaleNodes();
    const orphans = this.detectOrphans();
    return {
      violations,
      repaired,
      orphans,
      timestamp: new Date().toISOString(),
    };
  }
}
