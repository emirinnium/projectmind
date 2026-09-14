import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';

export function createDebtPrioritizeCommand(): Command {
  return new Command('debt-prioritize')
    .description('Show debt items sorted by severity and frequency')
    .option('-n, --limit <n>', 'Max items', '20')
    .option('--severity <level>', 'Filter: high|medium|low')
    .option('-j, --json', 'Output machine-readable JSON')
    .action(
      asyncHandler(async (opts: { limit: string; severity: string; json?: boolean }) => {
        const limit = Number.parseInt(opts.limit, 10);
        if (!Number.isInteger(limit) || limit < 1) {
          throw new Error(`--limit must be a positive integer: ${opts.limit}`);
        }
        if (opts.severity && !['high', 'medium', 'low'].includes(opts.severity)) {
          throw new Error(`--severity must be high, medium, or low: ${opts.severity}`);
        }
        await withService(['debt'], async (_ctx, services) => {
          const debt = services.debt!;

          const report = debt.getReport();
          let items = [...report.items];

          if (opts.severity) {
            items = items.filter((i) => i.severity === opts.severity);
          }

          const severityWeight = { high: 3, medium: 2, low: 1 };
          items.sort(
            (a, b) =>
              (severityWeight[b.severity as keyof typeof severityWeight] || 0) -
              (severityWeight[a.severity as keyof typeof severityWeight] || 0),
          );

          items = items.slice(0, limit);

          if (opts.json) {
            output.json({
              protocolVersion: 1,
              filters: { limit, severity: opts.severity ?? null },
              items,
              summary: report.bySeverity,
              totalItems: report.totalItems,
            });
            return;
          }

          output.section('Debt Prioritization');

          if (items.length === 0) {
            output.info('No debt items match the filters');
            return;
          }

          output.section(`Top ${items.length} Debt Items`);
          for (const [i, item] of items.entries()) {
            const icon = item.severity === 'high' ? '🔴' : item.severity === 'medium' ? '🟡' : '🟢';
            output.kv(`${i + 1}. ${icon} [${item.type}]`, item.filePath || 'project-wide');
            output.kv('Description', item.description);
            if (item.suggestion) output.kv('Suggestion', item.suggestion);
          }

          output.section('Summary');
          output.kv('High', report.bySeverity.high);
          output.kv('Medium', report.bySeverity.medium);
          output.kv('Low', report.bySeverity.low);
        });
      }),
    );
}
