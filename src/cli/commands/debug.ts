import { Command } from 'commander';
import { withContext, asyncHandler, output } from '@/cli/utils/shared.js';

export function createDebugCommand(): Command {
  const debugCmd = new Command('debug')
    .description('Debug and diagnostic commands');

  debugCmd
    .command('cache')
    .description('Show cache statistics')
    .action(asyncHandler(async () => {
      await withContext(async (ctx) => {
        const { CoherenceEngine } = await import('../../core/coherence/engine.js');
        const { DebtTracker } = await import('../../core/debt/tracker.js');
        
        const coherence = new CoherenceEngine(ctx.db);
        const debt = new DebtTracker(ctx.db, ctx.kg, coherence);
        
        output.section('Cache Statistics');
        output.kv('Coherence cache size', coherence.getCacheSize());
        output.kv('Coherence cache stats', JSON.stringify(coherence.getCacheStats()));
        
        const debtCacheStats = debt.getCacheStats();
        output.kv('Debt redundancy cache stats', JSON.stringify(debtCacheStats));
      });
    }));

  debugCmd
    .command('patterns')
    .description('Show extracted patterns')
    .option('-c, --category <name>', 'Filter by category')
    .option('-l, --limit <number>', 'Limit results', '20')
    .action(asyncHandler(async (opts: { category?: string; limit: string }) => {
      await withContext(async (ctx) => {
        const { PatternLibrary } = await import('../../parser/pattern-extractor.js');
        const patterns = new PatternLibrary(ctx.db);
        const allPatterns = patterns.getPatterns();
        
        let filtered = allPatterns;
        if (opts.category) {
          filtered = filtered.filter(p => p.category === opts.category);
        }
        
        output.section(`Patterns (${filtered.length} total)`);
        for (const p of filtered.slice(0, Number(opts.limit))) {
          output.kv(`[${p.category}] ${p.name}`, `conf=${p.confidence}, used=${p.usageCount}`);
          output.kv('  Description', p.description);
        }
      });
    }));

  debugCmd
    .command('imports')
    .description('Show import resolution stats')
    .action(asyncHandler(async () => {
      await withContext(async () => {
        const { getDatabase } = await import('../../storage/database.js');
        const db = getDatabase();
        
        const total = db.prepare('SELECT COUNT(*) as cnt FROM imports').get() as { cnt: number };
        const resolved = db.prepare('SELECT COUNT(*) as cnt FROM imports WHERE resolved = 1').get() as { cnt: number };
        
        output.section('Import Resolution');
        output.kv('Total imports', total.cnt);
        output.kv('Resolved', resolved.cnt);
        output.kv('Resolution rate', `${((resolved.cnt / total.cnt) * 100).toFixed(1)}%`);
        
        const byKind = db.prepare('SELECT kind, COUNT(*) as cnt FROM imports GROUP BY kind').all() as { kind: string; cnt: number }[];
        output.section('By kind');
        for (const k of byKind) {
          output.kv(`  ${k.kind || 'unknown'}`, k.cnt);
        }
        
        const unresolved = db.prepare('SELECT source, COUNT(*) as cnt FROM imports WHERE resolved = 0 GROUP BY source ORDER BY cnt DESC LIMIT 10').all() as { source: string; cnt: number }[];
        output.section('Top unresolved');
        for (const u of unresolved) {
          output.kv(`  ${u.source}`, u.cnt);
        }
      });
    }));

  debugCmd
    .command('db')
    .description('Show database info')
    .action(asyncHandler(async () => {
      await withContext(async () => {
        const { getDatabase } = await import('../../storage/database.js');
        const db = getDatabase();
        
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
        
        output.section('Database Tables');
        for (const t of tables) {
          const count = db.prepare(`SELECT COUNT(*) as cnt FROM ${t.name}`).get() as { cnt: number };
          output.kv(`  ${t.name}`, count.cnt);
        }
        
        const pageSize = db.prepare('PRAGMA page_size').get() as { page_size: number };
        const pageCount = db.prepare('PRAGMA page_count').get() as { page_count: number };
        output.section('Database Size');
        output.kv('Page size', `${pageSize.page_size} bytes`);
        output.kv('Page count', pageCount.page_count);
        output.kv('Total size', `${((pageSize.page_size * pageCount.page_count) / 1024 / 1024).toFixed(2)} MB`);
      });
    }));

  debugCmd
    .command('agent-touched')
    .description('Show agent-touched files')
    .action(asyncHandler(async () => {
      await withContext(async (ctx) => {
        const files = ctx.kg.getAgentTouchedFiles();
        output.section(`Agent-touched files (${files.length})`);
        for (const f of files.slice(0, 20)) {
          output.kv(`  ${f.relativePath}`, `by=${f.agentTouchedBy}, at=${f.agentTouchedAt}, load=${f.cognitiveLoad.toFixed(3)}`);
        }
      });
    }));

  debugCmd
    .command('circular-deps')
    .description('Show circular dependencies')
    .action(asyncHandler(async () => {
      await withContext(async (ctx) => {
        const cycles = ctx.kg.findCircularDependencies();
        output.section(`Circular dependencies (${cycles.length})`);
        for (const cycle of cycles) {
          output.kv('  Cycle', cycle.join(' -> '));
        }
      });
    }));

  debugCmd
    .command('profile')
    .description('Show last scan profile')
    .action(asyncHandler(async () => {
      await withContext(async (ctx) => {
        const { ScaleManager } = await import('../../core/scale/manager.js');
        const scale = new ScaleManager(ctx.db, ctx.kg);
        const profile = scale.getLastScanProfile();
        
        if (!profile) {
          output.warn('No scan profile found. Run "projectmind scan --profile" first.');
          return;
        }
        
        output.section('Last Scan Profile');
        output.kv('Total files', profile.totalFiles);
        output.kv('Scanned', profile.scannedFiles);
        output.kv('Errors', profile.errorFiles);
        output.kv('Duration', `${profile.durationMs}ms`);
        output.kv('Throughput', `${profile.filesPerSecond} files/sec`);
        output.kv('Memory delta', `${profile.memoryUsedMB} MB`);
        output.kv('Timestamp', profile.createdAt || 'unknown');
        
        if (profile.errors.length > 0) {
          output.section('Errors');
          for (const e of profile.errors.slice(0, 10)) {
            output.warn(`  ${e}`);
          }
          if (profile.errors.length > 10) {
            output.warn(`  ... and ${profile.errors.length - 10} more`);
          }
        }
      });
    }));

  return debugCmd;
}