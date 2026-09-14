import { Command } from 'commander';
import { withService, asyncHandler, getFilesToCheck, output } from '@/cli/utils/shared.js';
import { readFileSync } from 'node:fs';

export function createCheckCommand(): Command {
  return new Command('check')
    .description('Check coherence of files')
    .argument('[path]', 'File or directory path', '.')
    .option('-d, --deep', 'Use deep LLM analysis')
    .option('--offline', 'Offline mode — no code sent to cloud LLM')
    .option('-j, --json', 'Output machine-readable JSON')
    .action(
      asyncHandler(
        async (path: string, opts: { deep: boolean; offline: boolean; json?: boolean }) => {
          await withService(['coherence'], async (_ctx, services) => {
            const coherence = services.coherence!;

            const results: Array<{
              file: string;
              verdict: string;
              suggestions: string[];
            }> = [];

            // Set offline mode if requested
            if (opts.offline) {
              coherence.setOffline(true);
              if (!opts.json)
                output.info('Offline mode — using fast-tier analysis only (no cloud LLM)');
            } else {
              const hasLLM = coherence.hasLLMProvider();
              if (hasLLM && !opts.json) {
                output.info('Using LLM provider for deep analysis');
              } else if (!hasLLM && !opts.json) {
                output.info('No LLM provider available — using fast-tier analysis only');
              }
            }

            const files = await getFilesToCheck(path);

            let passCount = 0;
            let warnCount = 0;
            let failCount = 0;

            const contextFiles = _ctx.kg.getAgentTouchedFiles().slice(0, 5);

            for (const filePath of files) {
              const content = readFileSync(filePath, 'utf-8');
              const result = await coherence.checkCoherence({
                code: content,
                filePath: filePath,
                contextFiles,
                deepAnalysis: opts.deep,
                fastOnly: opts.offline || !opts.deep,
              });

              if (result.verdict === 'pass') passCount++;
              else if (result.verdict === 'warn') warnCount++;
              else failCount++;

              if (result.verdict !== 'pass') {
                if (!opts.json) {
                  output.warn(`[${result.verdict.toUpperCase()}] ${filePath}`);
                  for (const s of result.suggestions) {
                    output.warn(`  -> ${s}`);
                  }
                }
              }
              results.push({
                file: filePath,
                verdict: result.verdict,
                suggestions: result.suggestions,
              });
            }

            if (opts.json) {
              output.json({
                protocolVersion: 1,
                results,
                summary: {
                  files: results.length,
                  pass: passCount,
                  warn: warnCount,
                  fail: failCount,
                },
              });
            } else {
              output.info(`\nResults: ${passCount} pass, ${warnCount} warn, ${failCount} fail`);
            }
          });
        },
      ),
    );
}
