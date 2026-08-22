import { Command } from 'commander';
import { withService, asyncHandler, formatDebtReport, output } from '@/cli/utils/shared.js';

export function createDebtCommand(): Command {
  const cmd = new Command('debt')
    .description('Show cognitive debt report')
    .action(asyncHandler(async () => {
      await withService(['debt'], async (_ctx, services) => {
        const debt = services.debt!;
        const report = debt.getReport();
        output.info(formatDebtReport(report));
      });
    }));

  cmd
    .command('clear')
    .description('Clear all debt items from database')
    .action(asyncHandler(async () => {
      await withService(['debt'], async (_ctx, services) => {
        const debt = services.debt!;
        debt.clearAllDebt();
        output.success('All debt items cleared.');
      });
    }));

  cmd
    .command('detect')
    .description('Run debt detection on current codebase')
    .action(asyncHandler(async () => {
      await withService(['debt'], async (_ctx, services) => {
        const debt = services.debt!;
        output.info('Running debt detection...');
        const items = await debt.detectDebt();
        output.success(`Detected ${items.length} debt items.`);
      });
    }));

  cmd
    .command('clear-patterns')
    .description('Clear all extracted patterns from database')
    .action(asyncHandler(async () => {
      await withService(['debt'], async (_ctx, services) => {
        const debt = services.debt!;
        debt.clearPatterns();
        output.success('All patterns cleared.');
      });
    }));

  return cmd;
}