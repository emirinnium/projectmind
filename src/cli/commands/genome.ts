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

        // Rich breakdown from the persisted genome payload.
        try {
          const data = JSON.parse(genome.genomeData) as {
            patternCount?: number;
            violationCount?: number;
            agentSessions?: number;
            markerCount?: number;
            breakdown?: {
              avgConfidence?: number;
              highConfidencePatterns?: number;
              importResolutionRate?: number;
              circularDepPenalty?: number;
              violationPenalty?: number;
              markerCount?: number;
            };
          };
          output.kv('Patterns detected', String(data.patternCount ?? 0));
          output.kv('Violations', String(data.violationCount ?? 0));
          output.kv('Agent sessions', String(data.agentSessions ?? 0));
          output.kv('Marker count', String(data.markerCount ?? 0));
          const b = data.breakdown ?? {};
          if (typeof b.avgConfidence === 'number') output.kv('Avg pattern confidence', `${Math.round(b.avgConfidence * 100)}%`);
          if (typeof b.highConfidencePatterns === 'number') output.kv('High-confidence patterns', String(b.highConfidencePatterns));
          if (typeof b.importResolutionRate === 'number') output.kv('Import resolution rate', `${Math.round(b.importResolutionRate * 100)}%`);
          if (b.circularDepPenalty) output.warn(`Circular dependency penalty applied: ${b.circularDepPenalty}`);
          if (b.violationPenalty) output.warn(`Violation penalty applied: ${b.violationPenalty}`);
          if (b.markerCount !== undefined) output.kv('Breakdown marker count', String(b.markerCount));
        } catch {
          // Genome payload is informational — never block on parse issues.
        }
        output.kv('Genome data length', genome.genomeData.length);
      });
    }));
}