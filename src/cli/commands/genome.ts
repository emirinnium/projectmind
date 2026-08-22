import { Command } from 'commander';
import { withService, asyncHandler, output, formatGenomeScore } from '@/cli/utils/shared.js';

export function createGenomeCommand(): Command {
  return new Command('genome')
    .description('Compute and display project coherence genome')
    .action(asyncHandler(async () => {
      await withService(['debt'], async (_ctx, services) => {
        const debt = services.debt!;
        const genome = debt.computeGenome();
        const score = genome.coherenceScore;
        output.section('Coherence Genome');
        output.kv('Score', formatGenomeScore(score));
        output.kv('Genome data length', genome.genomeData.length);
      });
    }));
}