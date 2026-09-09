import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';

export function createResolveCommand(): Command {
  return new Command('resolve')
    .description('Resolve a debt item')
    .argument('<id>', 'Debt item ID')
    .action(
      asyncHandler(async (id: string) => {
        const debtId = Number(id);
        if (!Number.isSafeInteger(debtId) || debtId <= 0) {
          throw new Error(`Debt item ID must be a positive integer: ${id}`);
        }
        await withService(['debt'], async (_ctx, services) => {
          const debt = services.debt!;
          if (!debt.resolveDebt(debtId)) {
            throw new Error(`Unresolved debt item not found: ${debtId}`);
          }
          output.success(`Debt item ${debtId} resolved.`);
        });
      }),
    );
}
