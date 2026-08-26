import { Command } from 'commander';
import { withService, output } from '@/cli/utils/shared.js';
import { ProjectWatcher } from '@/core/watcher.js';

/**
 * pm watch — keep the knowledge graph warm in real time.
 *
 * Watches the project root (recursive fs.watch), debounces change events
 * into batches, re-parses each touched file individually and upserts it
 * into the KG. Coherence cache entries for updated files are invalidated.
 * Process-local daemon: Ctrl+C stops it and prints session stats.
 */
export function createWatchCommand(): Command {
  return new Command('watch')
    .description('Live-watch the project and incrementally refresh the knowledge graph on file changes')
    .option('--root <dir>', 'Root directory to watch (defaults to configured project root)')
    .option('--debounce <ms>', 'Batch settle window in milliseconds', '400')
    .action(async (opts: { root?: string; debounce?: string }) => {
      const debounceMs = Math.max(50, parseInt(opts.debounce ?? '400', 10) || 400);

      await withService(['coherence'], async (ctx, services) => {
        const watcher = new ProjectWatcher(ctx.kg, {
          root: opts.root,
          debounceMs,
          coherence: services.coherence ?? null,
          onBatchProcessed: ({ updated, failed }) => {
            if (updated.length > 0) {
              output.success(`⚡ ${updated.length} file(s) refreshed${failed.length > 0 ? `, ${failed.length} failed` : ''}`);
              for (const f of updated.slice(0, 5)) output.kv('  ↻', f);
              if (updated.length > 5) output.info(`  … +${updated.length - 5} more`);
            } else if (failed.length > 0) {
              output.warn(`${failed.length} file(s) could not be parsed (deleted or unsupported content) — full scan will reconcile`);
            }
          },
        });

        watcher.start();
        output.section('ProjectMind Watch');
        output.kv('Root', watcher.watchedRoot);
        output.kv('Debounce', `${debounceMs}ms`);
        output.info('Knowledge graph updates live. Press Ctrl+C to stop.');

        let stopping = false;
        const shutdown = () => {
          if (stopping) return;
          stopping = true;
          watcher.stop();
          const s = watcher.getStats();
          output.section('Watch Session Summary');
          output.kv('Events seen', String(s.eventsSeen));
          output.kv('Batches processed', String(s.batchesProcessed));
          output.kv('Files updated', String(s.filesUpdated));
          if (s.filesFailed > 0) output.kv('Files failed', String(s.filesFailed));
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        // Keep the process alive; all work happens via events.
        await new Promise<never>(() => {});
      });
    });
}
