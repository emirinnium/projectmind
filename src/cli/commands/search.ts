import { Command } from 'commander';
import { withService, asyncHandler, output, logger } from '@/cli/utils/shared.js';
import { readFileSync } from 'node:fs';
import { IntentEngine, createKgGraphAdapter } from '../../core/search/intent-engine.js';
import { parseFile } from '@/parser/ast-parser.js';
import { initializeConfiguredEmbeddingProvider } from '@/parser/embeddings.js';
import { resolve } from 'node:path';

export function createSearchCommand(): Command {
  return new Command('search')
    .description('Search code by pattern')
    .argument('<query>', 'Search query (text pattern)')
    .option('-t, --type <type>', 'Filter: function|class|interface|all', 'all')
    .option('-n, --limit <n>', 'Max results', '20')
    .action(
      asyncHandler(async (query: string, opts: { type: string; limit: string }) => {
        await withService(['scale'], async (ctx, services) => {
          const scale = services.scale!;
          const limit = Number.parseInt(opts.limit, 10);
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
            throw new Error(`--limit must be an integer between 1 and 1000: ${opts.limit}`);
          }
          if (!['function', 'class', 'interface', 'all'].includes(opts.type)) {
            throw new Error(`--type must be function, class, interface, or all: ${opts.type}`);
          }

          output.section(`Search: "${query}"`);

          // F39: intent-driven hybrid search first (KG + embeddings); any
          // failure or empty result set falls back to substring search below.
          let intentHandled = false;
          try {
            await initializeConfiguredEmbeddingProvider();
            const engine = new IntentEngine({ db: ctx.db, projectRoot: ctx.config.projectRoot });
            const results = await engine.search(
              { naturalLanguage: query },
              createKgGraphAdapter(ctx.kg),
              limit,
            );
            const filteredResults = results.filter((result) =>
              matchesRequestedType(result.filePath, opts.type, ctx.config.projectRoot),
            );
            if (filteredResults.length > 0) {
              intentHandled = true;
              output.section(`Results (${filteredResults.length}) — intent-ranked`);
              for (const r of filteredResults) {
                output.kv(
                  `  ${r.rank}. ${r.filePath}`,
                  `score: ${r.score.total.toFixed(2)} (${r.source ?? 'hybrid'}; ${r.semanticEvidence ?? 'unclassified'})`,
                );
                const firstLine = (r.snippet ?? '').split(/\r?\n/)[0]?.trim();
                if (firstLine) output.info(`     ${firstLine.substring(0, 100)}`);
              }
            }
          } catch (error) {
            logger.debug(
              `IntentEngine search failed — falling back to substring search: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (intentHandled) return;

          const report = scale.getScaleReport();
          const files = report.modules
            .flatMap((m) => m.files?.map((f) => f.path) || [])
            .slice(0, 100);

          const matches: Array<{ file: string; line: number; content: string }> = [];

          for (const file of files) {
            if (!matchesRequestedType(file, opts.type, ctx.config.projectRoot)) continue;
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
      }),
    );
}

function matchesRequestedType(filePath: string, type: string, projectRoot: string): boolean {
  if (type === 'all') return true;
  try {
    const structure = parseFile(resolve(projectRoot, filePath));
    if (!structure) return false;
    if (type === 'function') return structure.functions.length > 0;
    if (type === 'class') return structure.classes.length > 0;
    return /\binterface\s+[$A-Z_a-z][$\w]*/.test(structure.sourceText ?? '');
  } catch {
    return false;
  }
}
