import { Command } from 'commander';
import { withDebt, asyncHandler, output, formatGenomeScore } from '../utils/shared.js';

export function createGenomeCommand(): Command {
  return new Command('genome')
    .description('Compute and display project coherence genome')
    .action(asyncHandler(async () => {
      await withDebt(async (_ctx, debt) => {
        const genome = debt.computeGenome();
        const score = genome.coherenceScore;
        output.section('Coherence Genome');
        output.kv('Score', formatGenomeScore(score));
        output.kv('Pattern count', genome.breakdown.patternCount);
        output.kv('High confidence patterns', genome.breakdown.highConfidencePatterns);
        output.kv('Import resolution rate', `${(genome.breakdown.importResolutionRate * 100).toFixed(1)}%`);
        output.kv('Violation penalty', genome.breakdown.violationPenalty.toFixed(3));
        output.kv('Circular dep penalty', genome.breakdown.circularDepPenalty.toFixed(3));
        output.kv('Agent sessions', genome.breakdown.agentSessions);
      });
    }));
}