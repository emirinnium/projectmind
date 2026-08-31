import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';

export function createFindCircularDepsCommand(): Command {
  const cmd = new Command('find-circular-deps')
    .description('Find all circular dependencies in the project');

  cmd.action(asyncHandler(async () => {
    await withService(['scale'], async (ctx, services) => {
      const kg = services.scale!.getKnowledgeGraph();
      const cycles = kg.findCircularDependencies();

      output.section('Circular Dependencies');

      if (cycles.length === 0) {
        output.success('No circular dependencies found.');
        return;
      }

      output.kv('Count', cycles.length.toString());
      output.warn(`Found ${cycles.length} circular dependenc${cycles.length === 1 ? 'y' : 'ies'}:`);

      for (let i = 0; i < cycles.length; i++) {
        const cycle = cycles[i];
        output.kv(`Cycle ${i + 1}`, cycle.join(' -> '));
      }
    }, 'find-circular-deps');
  }));

  return cmd;
}
