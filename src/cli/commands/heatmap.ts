import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';

export function createHeatmapCommand(): Command {
  return new Command('heatmap')
    .description('Show coverage heatmap')
    .option('--format <fmt>', 'Output: text|json', 'text')
    .action(
      asyncHandler(async (opts: { format: string }) => {
        if (!['text', 'json'].includes(opts.format)) {
          throw new Error(`--format must be text or json: ${opts.format}`);
        }
        await withService(['scale'], async (_ctx, services) => {
          const scale = services.scale!;

          output.section('Coverage Heatmap');

          const heatmap = scale.getCoverageHeatmap();

          if (opts.format === 'json') {
            output.json(heatmap);
            return;
          }

          // Group by module
          const byModule = new Map<string, typeof heatmap>();
          for (const item of heatmap) {
            const mod = item.path.split('/')[0] || 'root';
            if (!byModule.has(mod)) byModule.set(mod, []);
            byModule.get(mod)!.push(item);
          }

          for (const [mod, items] of byModule) {
            const covered = items.filter((i) => i.covered).length;
            const total = items.length;
            const pct = total > 0 ? ((covered / total) * 100).toFixed(1) : '0.0';
            const filled = total > 0 ? Math.min(20, Math.floor((covered / total) * 20)) : 0;
            const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
            output.kv(`  ${bar} ${mod}`, `${covered}/${total} (${pct}%)`);
          }

          const report = scale.getScaleReport();
          output.kv('Overall coverage', `${(report.agentCoverage * 100).toFixed(1)}%`);
        });
      }),
    );
}
