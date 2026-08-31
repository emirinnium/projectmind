import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase, getStatement } from '../../../storage/database.js';
import { SCHEMA_SQL } from '../../../storage/schema.js';
import { KnowledgeGraph } from '../../../storage/knowledge-graph.js';
import { parseFile } from '../../../parser/ast-parser.js';
import { PatternLibrary } from '../../../parser/pattern-extractor.js';
import fg from 'fast-glob';
import { loadConfig } from '../../../utils/config.js';
import type { ScanProfile } from './types.js';

/** Files larger than this are skipped (not counted as errors). */
export const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Handles project scanning with performance profiling
 */
export class ProjectScanner {
  private db: DatabaseSync;
  private kg: KnowledgeGraph;

  constructor(db?: DatabaseSync, kg?: KnowledgeGraph) {
    this.db = db ?? getDatabase();
    this.db.exec(SCHEMA_SQL);
    this.kg = kg ?? new KnowledgeGraph();
  }

  async scanProject(rootPath?: string, full?: boolean): Promise<{ scanned: number; errors: number }> {
    const profile = await this.scanProjectWithProfile(rootPath, full);
    return { scanned: profile.scannedFiles, errors: profile.errorFiles };
  }

  async scanProjectWithProfile(rootPath?: string, full?: boolean): Promise<ScanProfile> {
    const startTime = Date.now();
    const startMemory = process.memoryUsage().heapUsed;
    
    const root = rootPath ?? loadConfig().projectRoot;
    const config = loadConfig();
    const ignorePatterns = [
      ...new Set([
        '**/node_modules/**',
        '**/dist/**',
        '**/dist-tests/**',
        '**/.git/**',
        '**/*.min.*',
        '**/*.map',
        '**/*.d.ts',
        '**/package-lock.json',
        '**/yarn.lock',
        '**/.next/**',
        '**/.turbo/**',
        '**/coverage/**',
        '**/.cache/**',
        '**/tmp/**',
        '**/temp/**',
        '**/.vscode/**',
        '**/.idea/**',
        '**/build/**',
        '**/out/**',
        '**/target/**',
        '**/__pycache__/**',
        '**/.venv/**',
        '**/vendor/**',
        ...config.ignorePatterns.map((p) => (p.startsWith('**') ? p : '**/' + p)),
      ]),
    ];

    // Note: only extensions with a registered parser in multilang-parser
    // LANGUAGE_MAP are included; unsupported ones (e.g. php) would otherwise
    // be counted as scan errors.
    const files = await fg(['**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,rb,c,cpp,h,hpp}'], {
      cwd: root,
      ignore: ignorePatterns,
      absolute: true,
    });

    this.pruneDeletedFiles(files, root);

    // Incremental scanning: only process files that have changed since last scan
    const changedFiles = full ? files : this.filterChangedFiles(files, root);

    let scanned = 0;
    let errors = 0;
    const errorDetails: string[] = [];
    const patternLib = new PatternLibrary(this.db);

    // Process files in batches for better performance
    const batchSize = 50;
    for (let i = 0; i < changedFiles.length; i += batchSize) {
      const batch = changedFiles.slice(i, i + batchSize);
      
      this.db.exec('BEGIN');
      try {
        for (const filePath of batch) {
          try {
            if (statSync(filePath).size > MAX_SCAN_FILE_BYTES) {
              continue;
            }
            const content = readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
            const fileStruct = parseFile(filePath, content);
            if (!fileStruct) {
              errors++;
              errorDetails.push(`${filePath}: Parse returned null`);
              continue;
            }

            const relPath = relative(root, filePath).replace(/\\/g, '/');
            const fileId = await this.kg.upsertFile(fileStruct, relPath);
            this.kg.storeFileDetails(fileId, fileStruct);
            // Extract patterns for genome scoring
            patternLib.extractPatterns(fileStruct);
            scanned++;
          } catch (e) {
            errors++;
            errorDetails.push(`${filePath}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        errorDetails.push(`Batch transaction failed: ${e instanceof Error ? e.message : String(e)}`);
        // Continue processing remaining batches instead of failing completely
      }
    }

    const durationMs = Date.now() - startTime;
    const endMemory = process.memoryUsage().heapUsed;
    
    return {
      totalFiles: files.length,
      scannedFiles: scanned,
      errorFiles: errors,
      durationMs,
      filesPerSecond: durationMs > 0 ? Math.round(scanned / (durationMs / 1000)) : 0,
      memoryUsedMB: Math.round((endMemory - startMemory) / 1024 / 1024 * 100) / 100,
      errors: errorDetails,
    };
  }

  /**
   * Remove KG rows for files that no longer exist on disk within the scanned
   * root. Project-scoped; chunked to respect SQLite's parameter limit.
   * Best-effort: a prune failure must never abort the scan.
   */
  private pruneDeletedFiles(files: string[], root: string): void {
    if (files.length === 0) return;
    try {
      const scanned = new Set(files.map((f) => relative(root, f).replace(/\\/g, '/')));
      const rows = getStatement('SELECT relative_path FROM files WHERE project_id = ?')
        .all(this.kg.getCurrentProjectId()) as Array<{ relative_path: string }>;
      const missing = rows.map((r) => r.relative_path).filter((p) => !scanned.has(p));
      const chunkSize = 999;
      for (let i = 0; i < missing.length; i += chunkSize) {
        const chunk = missing.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        getStatement(`DELETE FROM files WHERE project_id = ? AND relative_path IN (${placeholders})`)
          .run(this.kg.getCurrentProjectId(), ...chunk);
      }
    } catch {
      // best-effort prune — never abort the scan
    }
  }

  /**
    * Filter files to only include those that have changed since last scan.
   * Uses batch query for efficiency - fetches all last_scanned timestamps in a single query.
   */
  private filterChangedFiles(files: string[], root: string): string[] {
    if (files.length === 0) return [];
    
    const changed: string[] = [];
    const relPaths: string[] = [];
    const pathMap = new Map<string, string>(); // relPath -> absolute path
    
    for (const filePath of files) {
      try {
        const relPath = relative(root, filePath).replace(/\\/g, '/');
        relPaths.push(relPath);
        pathMap.set(relPath, filePath);
      } catch {
        changed.push(filePath);
      }
    }
    
    // Batch query: fetch all last_scanned timestamps in a single query
    const lastScannedMap = this.batchGetLastScanned(relPaths);
    
    for (const filePath of files) {
      try {
        const stat = statSync(filePath);
        const mtime = stat.mtimeMs;
        const relPath = relative(root, filePath).replace(/\\/g, '/');
        
        const lastScanned = lastScannedMap.get(relPath);
        if (lastScanned === undefined || mtime > lastScanned) {
          changed.push(filePath);
        }
      } catch {
        changed.push(filePath);
      }
    }
    
    return changed;
  }

  /**
   * Batch fetch last_scanned timestamps for multiple files in a single query.
   */
  private batchGetLastScanned(relPaths: string[]): Map<string, number> {
    const result = new Map<string, number>();
    if (relPaths.length === 0) return result;
    
    try {
      // Split into chunks of 999 to avoid SQLite parameter limit
      const chunkSize = 999;
      for (let i = 0; i < relPaths.length; i += chunkSize) {
        const chunk = relPaths.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = getStatement(
          `SELECT relative_path, last_scanned FROM files WHERE relative_path IN (${placeholders}) AND project_id = ?`
        ).all(...chunk, this.kg.getCurrentProjectId()) as Array<{ relative_path: string; last_scanned: string }>;
        
        for (const row of rows) {
          if (row.last_scanned) {
            const parsed = new Date(row.last_scanned + 'Z');
            if (!isNaN(parsed.getTime())) {
              result.set(row.relative_path, parsed.getTime());
            }
          }
        }
      }
    } catch {
      // If batch query fails, return empty map (all files will be scanned)
    }
    
    return result;
  }

  /**
   * Get the last scan timestamp for a single file by its relative path.
   * @deprecated Use batchGetLastScanned for multiple files instead.
   */
  private getFileLastScanned(relPath: string): number | null {
    try {
      const row = getStatement(
        'SELECT last_scanned FROM files WHERE relative_path = ? AND project_id = ? LIMIT 1'
      ).get(relPath, this.kg.getCurrentProjectId()) as { last_scanned: string } | undefined;

      if (row?.last_scanned) {
        const parsed = new Date(row.last_scanned + 'Z');
        if (!isNaN(parsed.getTime())) {
          return parsed.getTime();
        }
      }
    } catch {
      // Ignore errors
    }
    return null;
  }
}
