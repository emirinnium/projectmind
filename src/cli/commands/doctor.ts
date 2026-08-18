import { Command } from 'commander';
import { withServices, asyncHandler, output } from '../utils/shared.js';

export function createDoctorCommand(): Command {
  const doctorCmd = new Command('doctor')
    .description('Automated fixes and health remediation');

  doctorCmd
    .command('fix-imports')
    .description('Attempt to fix unresolved imports using path aliases')
    .option('--dry-run', 'Show what would be fixed without applying')
    .action(asyncHandler(async (opts: { dryRun?: boolean }) => {
      await withServices(['scale', 'coherence'], async (ctx, _services) => {
        const { getDatabase } = await import('../../storage/database.js');
        const db = getDatabase();
        
        // Get unresolved imports
        const unresolved = db.prepare(`
          SELECT i.*, f.relative_path as file_path 
          FROM imports i
          JOIN files f ON i.file_id = f.id
          WHERE i.resolved = 0
        `).all() as { id: number; source: string; file_path: string }[];
        
        output.section(`Found ${unresolved.length} unresolved imports`);
        
        let fixed = 0;
        let wouldFix = 0;
        
        // Load path aliases
        const config = ctx.config;
        const projectRoot = config.projectRoot;
        let aliases: { prefix: string; paths: string[] }[] = [];
        
        const tsconfigFile = ctx.kg.getFileByPath('tsconfig.json');
        if (tsconfigFile) {
          try {
            const { readFileSync } = await import('node:fs');
            const content = readFileSync(tsconfigFile.path, 'utf-8');
            const tsconfig = JSON.parse(content);
            if (tsconfig.compilerOptions?.paths) {
              for (const [prefix, paths] of Object.entries(tsconfig.compilerOptions.paths)) {
                aliases.push({
                  prefix: prefix.replace(/\*$/, ''),
                  paths: (paths as string[]).map(p => p.replace(/\*$/, '')),
                });
              }
            }
          } catch {
            // ignore
          }
        }
        
        for (const imp of unresolved) {
          // Try to resolve using aliases
          let resolved = false;
          let resolvedPath: string | null = null;
          
          for (const alias of aliases) {
            if (imp.source.startsWith(alias.prefix)) {
              const remainder = imp.source.slice(alias.prefix.length);
              for (const targetPath of alias.paths) {
                const { resolve } = await import('node:path');
                const candidate = resolve(projectRoot, targetPath + remainder).replace(/\\/g, '/');
                const found = ctx.kg.getFileByPath(candidate);
                if (found) {
                  resolved = true;
                  resolvedPath = found.relativePath;
                  break;
                }
              }
              if (resolved) break;
            }
          }
          
          if (!resolved) {
            // Try direct resolution
            const found = ctx.kg.resolveImportSource(imp.source);
            if (found) {
              resolved = true;
              resolvedPath = found.relativePath;
            }
          }
          
          if (!resolved) {
            // Try with extensions
            const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'];
            for (const ext of extensions) {
              const found = ctx.kg.resolveImportSource(imp.source + ext);
              if (found) {
                resolved = true;
                resolvedPath = found.relativePath;
                break;
              }
            }
          }
          
          if (resolved && resolvedPath) {
            wouldFix++;
            if (!opts.dryRun) {
              db.prepare('UPDATE imports SET resolved = 1, resolved_path = ? WHERE id = ?').run(resolvedPath, imp.id);
              fixed++;
            }
            output.success(`  ${imp.source} -> ${resolvedPath} (in ${imp.file_path})`);
          }
        }
        
        output.section(opts.dryRun ? 'Dry Run Summary' : 'Fix Summary');
        output.kv('Would fix', wouldFix);
        output.kv('Fixed', opts.dryRun ? 0 : fixed);
        
        if (opts.dryRun && wouldFix > 0) {
          output.info('Run without --dry-run to apply fixes');
        }
      });
    }));

  doctorCmd
    .command('clean-debt')
    .description('Clean up resolved/old debt items')
    .option('--older-than <days>', 'Delete resolved items older than N days', '30')
    .option('--dry-run', 'Show what would be deleted without applying')
    .action(asyncHandler(async (opts: { olderThan: string; dryRun?: boolean }) => {
      await withServices(['debt'], async (_ctx, _services) => {
        const { getDatabase } = await import('../../storage/database.js');
        const db = getDatabase();
        
        const days = Number(opts.olderThan);
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        
        // Get resolved debt items older than cutoff
        const resolvedItems = db.prepare(`
          SELECT id FROM debt_items 
          WHERE resolved = 1 AND resolved_at < ?
        `).all(cutoff) as { id: number }[];
        
        // Get all low severity items older than cutoff (likely noise)
        const oldLowItems = db.prepare(`
          SELECT id FROM debt_items 
          WHERE severity = 'low' AND detected_at < ? AND resolved = 0
        `).all(cutoff) as { id: number }[];
        
        output.section(`Debt Cleanup (older than ${days} days)`);
        output.kv('Resolved items to delete', resolvedItems.length);
        output.kv('Old low-severity items', oldLowItems.length);
        
        let deleted = 0;
        if (!opts.dryRun) {
          for (const item of [...resolvedItems, ...oldLowItems]) {
            db.prepare('DELETE FROM debt_items WHERE id = ?').run(item.id);
            deleted++;
          }
        }
        
        output.kv('Would delete', resolvedItems.length + oldLowItems.length);
        output.kv('Deleted', deleted);
        
        if (opts.dryRun && (resolvedItems.length + oldLowItems.length) > 0) {
          output.info('Run without --dry-run to apply cleanup');
        }
      });
    }));

  doctorCmd
    .command('rebuild-index')
    .description('Rebuild knowledge graph from scratch')
    .option('--dry-run', 'Show what would be done without applying')
    .action(asyncHandler(async (opts: { dryRun?: boolean }) => {
      await withServices(['scale'], async (_ctx, _services) => {
        const { getDatabase } = await import('../../storage/database.js');
        const db = getDatabase();
        
        // Count records that would be deleted
        const tables = [
          'files', 'functions', 'classes', 'imports', 
          'patterns', 'pattern_violations', 'coherence_decisions',
          'debt_items', 'circular_dependencies', 'scan_profiles',
          'project_genome'
        ];
        
        output.section('Rebuild Index - Tables to Clear');
        let totalRecords = 0;
        for (const table of tables) {
          const count = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number };
          output.kv(`  ${table}`, count.cnt);
          totalRecords += count.cnt;
        }
        
        output.kv('Total records', totalRecords);
        
        if (!opts.dryRun) {
          output.info('Clearing tables...');
          for (const table of tables) {
            db.exec(`DELETE FROM ${table}`);
          }
          // Reset auto-increment
          db.exec('DELETE FROM sqlite_sequence');
          
          output.success('Tables cleared. Run "projectmind scan" to rebuild.');
        } else {
          output.info('Dry run complete. Run without --dry-run to execute.');
        }
      });
    }));

  doctorCmd
    .command('scan-health')
    .description('Run comprehensive scan and health check')
    .action(asyncHandler(async () => {
      await withServices(['scale', 'debt', 'coherence'], async (_ctx, services) => {
        output.section('Running Scan...');
        const scanResult = await services.scale.scanProjectWithProfile();
        
        output.kv('Scanned', scanResult.scannedFiles);
        output.kv('Errors', scanResult.errorFiles);
        output.kv('Duration', `${scanResult.durationMs}ms`);
        output.kv('Throughput', `${scanResult.filesPerSecond} files/sec`);
        
        output.section('Running Debt Detection...');
        const debtItems = await services.debt.detectDebt();
        output.kv('Debt items detected', debtItems.length);
        
        const debtReport = services.debt.getReport();
        output.kv('High', debtReport.bySeverity.high);
        output.kv('Medium', debtReport.bySeverity.medium);
        output.kv('Low', debtReport.bySeverity.low);
        
        output.section('Computing Genome...');
        const genome = services.debt.computeGenome();
        output.kv('Score', `${(genome.coherenceScore * 100).toFixed(1)}%`);
        output.kv('Import resolution', `${(genome.breakdown.importResolutionRate * 100).toFixed(1)}%`);
        
        output.section('Summary');
        if (genome.coherenceScore > 0.85 && debtReport.bySeverity.high === 0) {
          output.success('Project is healthy!');
        } else {
          output.warn('Project needs attention');
          if (debtReport.bySeverity.high > 0) {
            output.warn(`  - ${debtReport.bySeverity.high} high-severity debt items`);
          }
          if (genome.coherenceScore <= 0.85) {
            output.warn(`  - Genome score below threshold: ${(genome.coherenceScore * 100).toFixed(1)}%`);
          }
        }
      });
    }));

  return doctorCmd;
}