import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { buildBugSurfaceReport } from '@/core/predictive/bug-surface.js';

export function createHeatmapCommand(): Command {
  return new Command('heatmap')
    .description('Show coverage heatmap')
    .option('--format <fmt>', 'Output: text|json', 'text')
    .option('--predictive', 'Show deterministic predictive bug-surface ranking')
    .option('--since <days>', 'Git history window for predictive mode', '90')
    .option('--limit <n>', 'Maximum predictive files', '20')
    .option('--minimum-score <n>', 'Minimum predictive score (0..1)', '0')
    .action(
      asyncHandler(async (opts: { format: string }) => {
        if (!['text', 'json'].includes(opts.format)) {
          throw new Error(`--format must be text or json: ${opts.format}`);
        }
        await withService(['scale'], async (ctx, services) => {
          const options = opts as typeof opts & {
            predictive?: boolean;
            since?: string;
            limit?: string;
            minimumScore?: string;
          };
          if (options.predictive) {
            const sinceDays = Number(options.since ?? '90');
            const limit = Number(options.limit ?? '20');
            const minimumScore = Number(options.minimumScore ?? '0');
            const report = buildBugSurfaceReport(ctx.db, ctx.kg, ctx.config.projectRoot, {
              sinceDays,
              limit,
              minimumScore,
            });
            if (options.format === 'json') {
              output.json(report);
              return;
            }
            output.section('Predictive Bug Surface');
            output.kv('Files', `${report.filesReported}/${report.filesConsidered}`);
            output.kv('Overall risk', report.summary.riskLevel);
            output.kv('Average score', report.summary.averageScore.toFixed(4));
            for (const item of report.items) {
              output.kv(`${item.riskLevel.toUpperCase()} ${item.path}`, item.score.toFixed(4));
              output.info(`  Evidence: ${item.evidence.join('; ')}`);
              for (const suggestion of item.suggestions) output.info(`  Action: ${suggestion}`);
            }
            for (const limitation of report.limitations) output.info(`Limit: ${limitation}`);
            return;
          }
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
