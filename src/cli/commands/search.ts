import { Command } from 'commander';
import { withService, asyncHandler, output, logger } from '@/cli/utils/shared.js';
import { readFileSync } from 'node:fs';

export function createSearchCommand(): Command {
  return new Command('search')
    .description('Search code by pattern')
    .argument('<query>', 'Search query (text pattern)')
    .option('-t, --type <type>', 'Filter: function|class|interface|all', 'all')
    .option('-n, --limit <n>', 'Max results', '20')
    .action(asyncHandler(async (query: string, opts: { type: string; limit: string }) => {
      await withService(['scale'], async (_ctx, services) => {
        const scale = services.scale!;
        
        output.section(`Search: "${query}"`);
        
        const report = scale.getScaleReport();
        const files = report.modules.flatMap(m => 
          m.files?.map(f => f.path) || []
        ).slice(0, 100);
        
        const matches: Array<{ file: string; line: number; content: string }> = [];
        
        for (const file of files) {
          try {
            const content = readFileSync(file, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                matches.push({ file, line: i + 1, content: lines[i].trim() });
                if (matches.length >= parseInt(opts.limit, 10)) break;
              }
            }
            if (matches.length >= parseInt(opts.limit, 10)) break;
          } catch {
            logger.debug(`Skipping file in search: ${file}`);
          }
        }
        
        if (matches.length === 0) {
          output.warn('No matches found');
          return;
        }
        
        output.section(`Results (${matches.length})`);
        for (const [i, m] of matches.entries()) {
          output.kv(`  ${i + 1}. ${m.file}:${m.line}`, m.content.substring(0, 100));
        }
      });
    }));
}