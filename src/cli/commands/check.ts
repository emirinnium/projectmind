import { Command } from 'commander';
import { withCoherence, asyncHandler, getFilesToCheck, output } from '../utils/shared.js';

export function createCheckCommand(): Command {
  return new Command('check')
    .description('Check coherence of files')
    .argument('[path]', 'File or directory path', '.')
    .option('-d, --deep', 'Use deep LLM analysis')
    .action(asyncHandler(async (path: string, opts: { deep: boolean }) => {
      await withCoherence(async (ctx, coherence) => {
        const hasLLM = coherence.hasLLMProvider();
        if (hasLLM) {
          output.info('Using LLM provider for deep analysis');
        } else {
          output.info('No LLM provider available — using fast-tier analysis only');
        }

        const files = await getFilesToCheck(path);

        let passCount = 0;
        let warnCount = 0;
        let failCount = 0;

        const contextFiles = ctx.kg.getAgentTouchedFiles().slice(0, 5);

        for (const filePath of files) {
          const { readFileSync } = await import('node:fs');
          const content = readFileSync(filePath, 'utf-8');
          const result = await coherence.checkCoherence({
            code: content,
            filePath: filePath,
            contextFiles,
            deepAnalysis: opts.deep,
            fastOnly: !hasLLM || !opts.deep,
          });

          if (result.verdict === 'pass') passCount++;
          else if (result.verdict === 'warn') warnCount++;
          else failCount++;

          if (result.verdict !== 'pass') {
            output.warn(`[${result.verdict.toUpperCase()}] ${filePath}`);
            for (const s of result.suggestions) {
              output.warn(`  -> ${s}`);
            }
          }
        }

        output.info(`\nResults: ${passCount} pass, ${warnCount} warn, ${failCount} fail`);
      });
    }));
}