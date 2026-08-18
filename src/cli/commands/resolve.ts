import { Command } from 'commander';
import { withDebt, asyncHandler, output } from '../utils/shared.js';

export function createResolveCommand(): Command {
  return new Command('resolve')
    .description('Resolve a debt item')
    .argument('<id>', 'Debt item ID')
    .action(asyncHandler(async (id: string) => {
      await withDebt(async (_ctx, debt) => {
        debt.resolveDebt(Number(id));
        output.success(`Debt item ${id} resolved.`);
      });
    }));
}