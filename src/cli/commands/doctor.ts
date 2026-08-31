import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getStatement } from '../../storage/database.js';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { ImpactPredictor } from '../../core/predictive/impact-predictor.js';
import { DEFAULT_PREDICTOR_CONFIG } from '../../core/predictive/config.js';
import type { PredictedFailure } from '../../core/predictive/types.js';
import { IntegrityGuard } from '../../core/kg/integrity-guard.js';
import { extractApiSurface, getApiAtRef, computeDiff, generateMarkdownReport, ExportedSymbol } from './api-surface-utils.js';
import { AliasResolver } from '../../parser/alias-resolver.js';
import { getDefaultAliasResolver } from '../../parser/alias-resolver.js';

/** ANSI color codes for risk level visualization (chalk-free). */
function formatRiskLevel(riskLevel?: string): string {
  switch (riskLevel) {
    case 'low':
      return '\x1b[32m✅\x1b[0m';
    case 'medium':
      return '\x1b[33m⚠️\x1b[0m';
    case 'high':
      return '\x1b[38;5;208m🚨\x1b[0m';
    case 'critical':
      return '\x1b[31m💥\x1b[0m';
    default:
      return '';
  }
}

export function createDoctorCommand(): Command {
  const doctorCmd = new Command('doctor')
    .description('Automated fixes and health remediation');

  doctorCmd
    .command('fix-imports')
    .description('Analyze unresolved imports and suggest alias/path fixes')
    .option('--limit <n>', 'Max files to show', '25')
    .option('--suggest-aliases', 'Generate alias suggestions for unresolved imports', false)
    .action(asyncHandler(async (opts: { limit?: string; suggestAliases?: boolean }) => {
      await withService(['scale'], async (ctx, _services) => {
        output.section('Unresolved Imports Analysis');

        // Real data: every import recorded as unresolved during scan.
        const rows = getStatement(
          `SELECT f.relative_path AS file, i.source AS src, i.kind AS kind
           FROM imports i JOIN files f ON f.id = i.file_id
           WHERE f.project_id = ? AND i.resolved = 0
           ORDER BY f.relative_path`
        ).all(ctx.kg.getCurrentProjectId()) as Array<{ file: string; src: string; kind: string }>;

        if (rows.length === 0) {
          output.success('All imports are resolved. Nothing to fix.');
          return;
        }

        // Use the AliasResolver for comprehensive alias resolution
        const aliasResolver = getDefaultAliasResolver();
        const aliases = aliasResolver.getAliases();

        // Group by file and produce suggestions.
        const byFile = new Map<string, Array<{ source: string; hint: string; suggestion?: string }>>();
        let aliasFixable = 0;
        let dynamicImportCount = 0;
        let jsonModuleCount = 0;

        for (const r of rows) {
          const list = byFile.get(r.file) ?? [];
          let hint = '';
          let suggestion: string | undefined;

          // Track import kinds
          if (r.kind === 'dynamic-import') {
            dynamicImportCount++;
          } else if (r.kind === 'json') {
            jsonModuleCount++;
          }

          // Try alias resolution for bare imports
          if (!r.src.startsWith('./') && !r.src.startsWith('../') && !r.src.startsWith('node:')) {
            const aliasResult = aliasResolver.resolveAlias(r.src);
            if (aliasResult.matched) {
              aliasFixable++;
              hint = `alias match: ${aliasResult.resolvedCandidates.join(', ')}`;
              if (opts.suggestAliases && aliasResult.resolvedCandidates.length > 0) {
                suggestion = `Consider adding to tsconfig paths: "${r.src}" -> "${aliasResult.resolvedCandidates[0]}"`;
              }
            }
          }

          if (!hint) {
            if (r.src.startsWith('node:')) {
              hint = 'node built-in (resolved)';
            } else if (r.kind === 'dynamic-import') {
              hint = 'dynamic import - verify at runtime';
            } else if (r.kind === 'json') {
              hint = 'JSON module - verify file exists';
            } else if (/^[./]/.test(r.src)) {
              hint = 'relative — check file exists / extension';
            } else {
              hint = 'external package';
            }
          }

          list.push({ source: r.src, hint, suggestion });
          byFile.set(r.file, list);
        }

        const limit = Math.max(1, parseInt(opts.limit ?? '25', 10));
        output.kv('Files affected', byFile.size);
        output.kv('Unresolved imports', rows.length);
        output.kv('Alias-fixable', aliasFixable);
        if (dynamicImportCount > 0) output.kv('Dynamic imports', dynamicImportCount);
        if (jsonModuleCount > 0) output.kv('JSON modules', jsonModuleCount);

        // Show current aliases if any
        if (aliases.length > 0) {
          output.section('Configured Aliases');
          for (const a of aliases.slice(0, 10)) {
            output.kv(a.prefix, a.targets.join(', '));
          }
          if (aliases.length > 10) output.info(`... and ${aliases.length - 10} more aliases`);
        }

        output.section('Details');
        for (const [file, list] of [...byFile.entries()].slice(0, limit)) {
          output.kv(file, `${list.length} unresolved`);
          for (const l of list.slice(0, 5)) {
            output.warn(`   - ${l.source} (${l.hint})`);
            if (l.suggestion) output.info(`     → ${l.suggestion}`);
          }
        }
        if (byFile.size > limit) output.info(`…and ${byFile.size - limit} more files`);

        // Generate alias suggestions if requested
        if (opts.suggestAliases) {
          output.section('Alias Suggestions');
          const suggestedAliases = generateAliasSuggestions(rows, aliasResolver);
          if (suggestedAliases.length > 0) {
            output.info('Suggested tsconfig.json path entries:');
            for (const sug of suggestedAliases.slice(0, 10)) {
              output.warn(`  "${sug.prefix}": ["${sug.target}"]`);
              output.info(`    (for import: ${sug.exampleImport})`);
            }
          } else {
            output.info('No alias suggestions generated.');
          }
        }

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
      await withService(['scale', 'debt', 'coherence'], async (ctx, services) => {
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
        output.section('Marker Count');
        output.kv('TODO/FIXME markers', String(genome.breakdown?.markerCount ?? 0));
        
        output.section('Predictive Impact Analysis');
        // F39: run the predictor against the REAL project database instead of
        // a hardcoded sample change. Historical correlation uses a real
        // recently-changed file when the DB has one; otherwise skip clearly.
        const predictor = new ImpactPredictor(DEFAULT_PREDICTOR_CONFIG, ctx.db);
        let recentFile: string | null = null;
        try {
          const touched = ctx.db
            .prepare('SELECT path FROM files WHERE agent_touched = 1 ORDER BY last_scanned DESC LIMIT 1')
            .get() as { path?: string } | undefined;
          const anyFile = touched ?? (ctx.db
            .prepare('SELECT path FROM files ORDER BY last_scanned DESC LIMIT 1')
            .get() as { path?: string } | undefined);
          recentFile = anyFile?.path ?? null;
        } catch {
          recentFile = null;
        }
        if (!recentFile) {
          output.info('Skipped — no files in the project database yet (run "projectmind scan" first).');
        } else {
          output.kv('Recently changed file', recentFile);
          const historical = predictor.correlateHistoricalFailures(recentFile);
          output.kv('Historical failure rate', `${(historical.avgFailureRate * 100).toFixed(1)}%`);
          output.kv(
            'Common broken tests',
            historical.commonBrokenTests.length > 0 ? historical.commonBrokenTests.join(', ') : 'none recorded'
          );
          const prediction = predictor.predictImpact({
            filePath: recentFile,
            moduleName: basename(dirname(recentFile)) || recentFile,
            changeType: 'modify',
            crossModule: false,
          });
          output.kv('Prediction ID', prediction.predictionId);
          output.kv('Predicted impact', `${(prediction.predictedImpact * 100).toFixed(1)}%`);
          output.kv('Total confidence', `${(prediction.totalConfidence * 100).toFixed(1)}%`);
          output.kv('Affected modules', prediction.affectedModules.join(', ') || 'none');

          // Display predicted failures with risk levels
          const testBreaks = predictor.predictTestBreaks({
            filePath: recentFile,
            moduleName: basename(dirname(recentFile)) || recentFile,
            changeType: 'modify',
            crossModule: false,
          });
          if (testBreaks.length > 0) {
            output.section('Predicted Test Breakages');
            for (const failure of testBreaks.slice(0, 10)) {
              const risk = formatRiskLevel(failure.riskLevel);
              output.kv(`  ${risk} ${failure.functionName}`, `${(failure.confidence * 100).toFixed(0)}% — ${failure.reason.substring(0, 80)}`);
            }
            if (testBreaks.length > 10) {
              output.info(`  ... and ${testBreaks.length - 10} more predicted failure(s)`);
            }
          }
        }

        // API surface diff
        output.section('API Surface Diff');
        try {
          const config = await import('../../utils/config.js');
          const projectRoot = config.loadConfig().projectRoot || process.cwd();
          const allFiles = scale.getScaleReport().modules.flatMap(m => m.files || []);
          const tsFiles = allFiles.filter(f => f.language === 'typescript');
          const currentApi = await extractApiSurface(tsFiles, projectRoot);
          
          let baseApi: ExportedSymbol[] = [];
          try {
            baseApi = await getApiAtRef('HEAD~1', projectRoot);
          } catch {}
          
          if (baseApi && baseApi.length > 0) {
            const diff = computeDiff(baseApi, currentApi);
            output.kv('Current exports', String(currentApi.length));
            output.kv('Base exports', String(baseApi.length));
            if (diff.added.length > 0) output.kv('✅ Added', String(diff.added.length));
            if (diff.removed.length > 0) output.kv('❌ Removed', String(diff.removed.length));
            if (diff.changed.length > 0) output.kv('🔄 Changed', String(diff.changed.length));
            if (diff.breaking.length > 0) output.kv('💥 Breaking', String(diff.breaking.length));
          } else {
            output.info('No base reference (HEAD~1) available for API surface diff.');
          }
        } catch (e) {
          output.warn(`API surface analysis failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        
        // Test quality trend
        output.section('Test Quality Trend');
        const genomeScore = genome.coherenceScore * 100;
        output.kv('Current score', `${genomeScore.toFixed(1)}%`);
        try {
          const trendPath = '.projectmind/pm-genome-trend.json';
          if (existsSync(trendPath)) {
            const trendData = JSON.parse(readFileSync(trendPath, 'utf-8'));
            if (trendData.lastScore !== undefined) {
              const change = (genomeScore - trendData.lastScore).toFixed(1);
              const direction = parseFloat(change) >= 0 ? '↑' : '↓';
              output.kv(`Last score`, `${trendData.lastScore.toFixed(1)}% ${direction} ${change}%`);
              if (Math.abs(parseFloat(change)) > 5) {
                output.kv('Trend', `Significant ${parseFloat(change) > 0 ? 'improvement' : 'decline'}`);
              }
            }
          }
        } catch {
          // No trend data available
        }
        
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

/**
 * Generate alias suggestions for unresolved imports by analyzing import
 * patterns and finding common prefixes that could be mapped to directories.
 */
function generateAliasSuggestions(
  rows: Array<{ file: string; src: string; kind: string }>,
  aliasResolver: AliasResolver
): Array<{ prefix: string; target: string; exampleImport: string }> {
  const suggestions: Array<{ prefix: string; target: string; exampleImport: string }> = [];
  const existingAliases = aliasResolver.getAliases();
  const existingPrefixes = new Set(existingAliases.map(a => a.prefix));

  // Group imports by common prefixes (e.g., 'src/', 'components/')
  const prefixCounts = new Map<string, { count: number; example: string }>();

  for (const row of rows) {
    // Skip relative imports, node builtins, dynamic imports, and JSON modules
    if (row.src.startsWith('./') || row.src.startsWith('../') || row.src.startsWith('node:') ||
        row.kind === 'dynamic-import' || row.kind === 'json') {
      continue;
    }

    // Skip if already matches an existing alias
    let matchesExisting = false;
    for (const prefix of existingPrefixes) {
      if (row.src.startsWith(prefix)) {
        matchesExisting = true;
        break;
      }
    }
    if (matchesExisting) continue;

    // Extract potential prefix (first path segment)
    const parts = row.src.split('/');
    if (parts.length >= 2) {
      const potentialPrefix = parts[0] + '/';
      // Only suggest if it looks like a directory prefix (not a package scope)
      if (!potentialPrefix.startsWith('@')) {
        const current = prefixCounts.get(potentialPrefix) ?? { count: 0, example: row.src };
        current.count++;
        prefixCounts.set(potentialPrefix, current);
      }
    }
  }

  // Generate suggestions for prefixes that appear multiple times
  for (const [prefix, info] of prefixCounts) {
    if (info.count >= 2) {
      // Suggest mapping to src/ directory as a convention
      suggestions.push({
        prefix,
        target: `src/${prefix}`,
        exampleImport: info.example,
      });
    }
  }

  return suggestions;
}