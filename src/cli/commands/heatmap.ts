import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';

export function createHeatmapCommand(): Command {
  return new Command('heatmap')
    .description('Show coverage heatmap')
    .option('--format <fmt>', 'Output: text|json', 'text')
    .action(
      asyncHandler(async (opts: { format: string }) => {
        await withService(['scale'], async (_ctx, services) => {
          const scale = services.scale!;

          output.section('Coverage Heatmap');

          const heatmap = scale.getCoverageHeatmap();

          if (opts.format === 'json') {
            console.log(JSON.stringify(heatmap, null, 2));
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
            const bar =
              '█'.repeat(Math.floor((covered / total) * 20)) +
              '░'.repeat(20 - Math.floor((covered / total) * 20));
            output.kv(`  ${bar} ${mod}`, `${covered}/${total} (${pct}%)`);
          }

          const report = scale.getScaleReport();
          output.kv('Overall coverage', `${(report.agentCoverage * 100).toFixed(1)}%`);
        });
      }),
    );
}
