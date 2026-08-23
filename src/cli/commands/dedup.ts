import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';

export function createDedupCommand(): Command {
  return new Command('dedup')
    .description('Find duplicate code using existing redundancy detection')
    .action(asyncHandler(async () => {
      await withService(['debt'], async (_ctx, services) => {
        const debt = services.debt!;
        
        output.section('Code Deduplication');
        output.info('Running debt detection to find redundancy...');
        
        const items = await debt.detectDebt();
        const redundancyItems = items.filter(i => i.type === 'redundancy');
        
        if (redundancyItems.length === 0) {
          output.success('No redundancy detected');
          return;
        }
        
        output.section(`Redundancy Items (${redundancyItems.length})`);
        for (const [i, item] of redundancyItems.slice(0, 20).entries()) {
          output.kv(`${i + 1}. ${item.filePath || 'project-wide'}`, item.description);
          if (item.suggestion) output.kv('Suggestion', item.suggestion);
        }
        
        output.info('Note: Full structural/semantic deduplication requires additional core services.');
      });
    }));
}