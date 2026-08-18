import { Command } from 'commander';
import { withDebt, asyncHandler, formatDebtReport, output } from '../utils/shared.js';

export function createDebtCommand(): Command {
  const cmd = new Command('debt')
    .description('Show cognitive debt report')
    .action(asyncHandler(async () => {
      await withDebt(async (_ctx, debt) => {
        const report = debt.getReport();
        output.info(formatDebtReport(report));
      });
    }));

  cmd
    .command('clear')
    .description('Clear all debt items from database')
    .action(asyncHandler(async () => {
      await withDebt(async (_ctx, debt) => {
        debt.clearAllDebt();
        output.success('All debt items cleared.');
      });
    }));

  cmd
    .command('detect')
    .description('Run debt detection on current codebase')
    .action(asyncHandler(async () => {
      await withDebt(async (_ctx, debt) => {
        output.info('Running debt detection...');
        const items = await debt.detectDebt();
        output.success(`Detected ${items.length} debt items.`);
      });
    }));

  cmd
    .command('clear-patterns')
    .description('Clear all extracted patterns from database')
    .action(asyncHandler(async () => {
      await withDebt(async (_ctx, debt) => {
        debt.clearPatterns();
        output.success('All patterns cleared.');
      });
    }));

  return cmd;
}