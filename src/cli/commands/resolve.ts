import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';

export function createResolveCommand(): Command {
  return new Command('resolve')
    .description('Resolve a debt item')
    .argument('<id>', 'Debt item ID')
    .action(asyncHandler(async (id: string) => {
      await withService(['debt'], async (_ctx, services) => {
        const debt = services.debt!;
        debt.resolveDebt(Number(id));
        output.success(`Debt item ${id} resolved.`);
      });
    }));
}