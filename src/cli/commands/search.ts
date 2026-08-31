import { Command } from 'commander';
import { withService, asyncHandler, output, logger } from '@/cli/utils/shared.js';
import { readFileSync } from 'node:fs';
import { IntentEngine, createKgGraphAdapter } from '../../core/search/intent-engine.js';

export function createSearchCommand(): Command {
  return new Command('search')
    .description('Search code by pattern')
    .argument('<query>', 'Search query (text pattern)')
    .option('-t, --type <type>', 'Filter: function|class|interface|all', 'all')
    .option('-n, --limit <n>', 'Max results', '20')
    .action(asyncHandler(async (query: string, opts: { type: string; limit: string }) => {
      await withService(['scale'], async (ctx, services) => {
        const scale = services.scale!;
        const limit = parseInt(opts.limit, 10);

        output.section(`Search: "${query}"`);

        // F39: intent-driven hybrid search first (KG + embeddings); any
        // failure or empty result set falls back to substring search below.
        let intentHandled = false;
        try {
          const engine = new IntentEngine({ db: ctx.db, projectRoot: ctx.config.projectRoot });
          const results = await engine.search(
            { naturalLanguage: query },
            createKgGraphAdapter(ctx.kg),
            limit
          );
          if (results.length > 0) {
            intentHandled = true;
            output.section(`Results (${results.length}) — intent-ranked`);
            for (const r of results) {
              output.kv(`  ${r.rank}. ${r.filePath}`, `score: ${r.score.total.toFixed(2)} (${r.source ?? 'hybrid'})`);
              const firstLine = (r.snippet ?? '').split(/\r?\n/)[0]?.trim();
              if (firstLine) output.info(`     ${firstLine.substring(0, 100)}`);
            }
          }
        } catch (error) {
          logger.debug(`IntentEngine search failed — falling back to substring search: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (intentHandled) return;

        const report = scale.getScaleReport();
        const files = report.modules.flatMap(m => 
          m.files?.map(f => f.path) || []
        ).slice(0, 100);
        
        const matches: Array<{ file: string; line: number; content: string }> = [];
        
        for (const file of files) {
          try {
            const content = readFileSync(file, 'utf-8');
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                matches.push({ file, line: i + 1, content: lines[i].trim() });
                if (matches.length >= limit) break;
              }
            }
            if (matches.length >= limit) break;
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
