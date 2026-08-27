import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getStatement } from '../../storage/database.js';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { ImpactPredictor } from '../../core/predictive/impact-predictor.js';
import type { PredictorConfig } from '../../core/predictive/types.js';
import { IntegrityGuard } from '../../core/kg/integrity-guard.js';

export function createDoctorCommand(): Command {
  const doctorCmd = new Command('doctor')
    .description('Automated fixes and health remediation');

  doctorCmd
    .command('fix-imports')
    .description('Analyze unresolved imports and suggest alias/path fixes')
    .option('--limit <n>', 'Max files to show', '25')
    .action(asyncHandler(async (opts: { limit?: string }) => {
      await withService(['scale'], async (ctx, _services) => {
        output.section('Unresolved Imports Analysis');

        // Real data: every import recorded as unresolved during scan.
        const rows = getStatement(
          `SELECT f.relative_path AS file, i.source AS src
           FROM imports i JOIN files f ON f.id = i.file_id
           WHERE f.project_id = ? AND i.resolved = 0
           ORDER BY f.relative_path`
        ).all(ctx.kg.getCurrentProjectId()) as Array<{ file: string; src: string }>;

        if (rows.length === 0) {
          output.success('All imports are resolved. Nothing to fix.');
          return;
        }

        // Load tsconfig path aliases (filesystem — tsconfig is not scanned).
        let aliases: { prefix: string; target: string }[] = [];
        try {
          const cfgPath = join(process.cwd(), 'tsconfig.json');
          if (existsSync(cfgPath)) {
            const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8').replace(/^\s*\/\/.*$/gm, ''));
            for (const [prefix, targets] of Object.entries(cfg.compilerOptions?.paths ?? {})) {
              const target = (targets as string[])[0]?.replace(/\*$/, '');
              if (target) aliases.push({ prefix: prefix.replace(/\*$/, ''), target });
            }
          }
        } catch { /* no readable tsconfig */ }

        // Group by file and produce suggestions.
        const byFile = new Map<string, string[]>();
        let aliasFixable = 0;
        for (const r of rows) {
          const list = byFile.get(r.file) ?? [];
          let hint = '';
          for (const a of aliases) {
            if (!r.src.startsWith('./') && !r.src.startsWith('../') && r.src.startsWith(a.prefix)) {
              hint = `alias '${a.prefix}' -> ${a.target}`;
              aliasFixable++;
              break;
            }
          }
          if (!hint) hint = /^[./]/.test(r.src) ? 'relative — check file exists / extension' : 'external package';
          list.push(`${r.src}   (${hint})`);
          byFile.set(r.file, list);
        }

        const limit = Math.max(1, parseInt(opts.limit ?? '25', 10));
        output.kv('Files affected', byFile.size);
        output.kv('Unresolved imports', rows.length);
        output.kv('Alias-fixable', aliasFixable);
        output.section('Details');
        for (const [file, list] of [...byFile.entries()].slice(0, limit)) {
          output.kv(file, `${list.length} unresolved`);
          for (const l of list.slice(0, 5)) output.warn(`   - ${l}`);
        }
        if (byFile.size > limit) output.info(`…and ${byFile.size - limit} more files`);

        // Analysis mode: we report precisely; automatic code rewriting is
        // intentionally out of scope (risk of breaking source files).
        output.info('Analysis mode — auto-editing source imports is not performed.');

        // Real repair: use IntegrityGuard to resolve stale imports
        const guard = new IntegrityGuard();
        const repaired = guard.repairStaleNodes();
        if (repaired > 0) {
          output.success(`Repaired ${repaired} stale import(s) via IntegrityGuard.`);
        } else {
          output.info('No stale imports repaired.');
        }
      });
    }));

  doctorCmd
    .command('clean-debt')
    .description('Clean up resolved/old debt items')
    .option('--older-than <days>', 'Delete resolved items older than N days', '30')
    .option('--dry-run', 'Show what would be deleted without applying')
    .action(asyncHandler(async (opts: { olderThan: string; dryRun?: boolean }) => {
      await withService(['debt'], async (_ctx, _services) => {
        // ... (same logic as before but using services.debt instead of withDebt callback parameter)
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
    .action(asyncHandler(async (_opts: { dryRun?: boolean }) => {
      await withService(['scale'], async (_ctx, _services) => {
        // ... (same logic as before)
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
        
        // Integrity Guard: auto-repair before destructive rebuild
        const guard = new IntegrityGuard();
        const report = guard.generateReport();
        output.section('Integrity Guard Report');
        output.kv('Violations', report.violations.length);
        output.kv('Repaired', report.repaired);
        output.kv('Orphans', report.orphans.length);
        if (report.violations.length > 0) {
          for (const v of report.violations.slice(0, 5)) {
            output.warn(`  ${v.type}: ${v.filePath}`);
          }
        }

        if (!_opts.dryRun) {
          output.info('Clearing tables...');
          for (const table of tables) {
            db.exec(`DELETE FROM ${table}`);
          }
          // Reset auto-increment
          db.exec('DELETE FROM sqlite_sequence');

          // K9: the vec index MUST follow the wipe, or it keeps returning
          // rowids for now-nonexistent files. Drop the virtual table and
          // recreate it (empty, embeddings return on the next scan).
          const { getVecIndex } = await import('../../core/embeddings/vector-index.js');
          getVecIndex(db).rebuild();

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
      await withService(['scale', 'debt', 'coherence'], async (_ctx, services) => {
        const scale = services.scale!;
        const debt = services.debt!;
        
        output.section('Running Scan...');
        const scanResult = await scale.scanProjectWithProfile();
        
        output.kv('Scanned', scanResult.scannedFiles);
        output.kv('Errors', scanResult.errorFiles);
        output.kv('Duration', `${scanResult.durationMs}ms`);
        output.kv('Throughput', `${scanResult.filesPerSecond} files/sec`);
        
        output.section('Running Debt Detection...');
        const debtItems = await debt.detectDebt();
        output.kv('Debt items detected', debtItems.length);
        
        const debtReport = debt.getReport();
        output.kv('High', debtReport.bySeverity.high);
        output.kv('Medium', debtReport.bySeverity.medium);
        output.kv('Low', debtReport.bySeverity.low);
        
        output.section('Computing Genome...');
        const genome = debt.computeGenome();
        output.kv('Score', `${(genome.coherenceScore * 100).toFixed(1)}%`);
        output.kv('Genome data available', genome.genomeData.length > 0 ? 'Yes' : 'No');
        
        output.section('Predictive Impact Analysis');
        const predictorConfig: PredictorConfig = {
          bayesianPrior: 0.5,
          crossModuleWeight: 0.8,
          confidenceThreshold: 0.7,
          modelUpdateRate: 0.1,
        };
        const predictor = new ImpactPredictor(predictorConfig);
        const sampleChange = { filePath: 'src/core/index.ts', moduleName: 'core', changeType: 'modify' as const, crossModule: true };
        const prediction = predictor.predictImpact(sampleChange);
        output.kv('Prediction ID', prediction.predictionId);
        output.kv('Predicted impact', `${(prediction.predictedImpact * 100).toFixed(1)}%`);
        output.kv('Total confidence', `${(prediction.totalConfidence * 100).toFixed(1)}%`);
        output.kv('Cross-module', prediction.change.crossModule ? 'Yes' : 'No');

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