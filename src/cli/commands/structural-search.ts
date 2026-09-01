import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import {
  StructuralSearcher,
  type StructuralSearchOptions,
  type StructuralReplaceOptions,
} from '@/parser/structural-search.js';

const searcher = new StructuralSearcher();

export function createStructuralSearchCommand(): Command {
  const structuralSearchCmd = new Command('structural-search').description(
    'AST-based structural search/replace across the codebase',
  );

  structuralSearchCmd
    .command('search')
    .description('Search for AST nodes matching a pattern')
    .requiredOption(
      '-k, --kind <kind>',
      'AST node kind (e.g., FunctionDeclaration, CallExpression, IfStatement)',
    )
    .option('-m, --modifier <modifier>', 'Required modifier (e.g., async, export)')
    .option('-c, --contains <text>', 'Text that must appear inside the matched node')
    .option('-n, --name-pattern <pattern>', 'Regex pattern for the node name')
    .option('-f, --file-patterns <patterns>', 'Comma-separated glob patterns for files to search')
    .option('--max-results <n>', 'Maximum number of results', '50')
    .action(
      asyncHandler(
        async (opts: {
          kind: string;
          modifier?: string;
          contains?: string;
          namePattern?: string;
          filePatterns?: string;
          maxResults: string;
        }) => {
          await withService(['scale'], async (ctx) => {
            const kg = ctx.kg;
            const files = kg.getAllFiles();
            const filePaths = files.map((f) => f.path);

            const searchOptions: StructuralSearchOptions = {
              nodeKind: opts.kind,
              hasModifier: opts.modifier,
              containsText: opts.contains,
              namePattern: opts.namePattern,
              filePatterns: opts.filePatterns?.split(',').map((p) => p.trim()),
              maxResults: parseInt(opts.maxResults, 10),
            };

            const matches = searcher.search(searchOptions, filePaths);

            output.section(`Structural Search: ${opts.kind} (${matches.length} matches)`);

            if (matches.length === 0) {
              output.warn('No matches found.');
              return;
            }

            for (const m of matches.slice(0, 50)) {
              output.kv(
                `${m.filePath}:${m.startLine}-${m.endLine}`,
                `${m.nodeKind} — ${m.text.substring(0, 120)}${m.text.length > 120 ? '...' : ''}`,
              );
            }

            if (matches.length > 50) {
              output.info(
                `... and ${matches.length - 50} more matches. Use --max-results to see more.`,
              );
            }
          });
        },
      ),
    );

  structuralSearchCmd
    .command('replace')
    .description('Replace AST nodes matching a pattern')
    .requiredOption('-k, --kind <kind>', 'AST node kind to match')
    .requiredOption('-r, --replacement <text>', 'Replacement text')
    .option('-m, --modifier <modifier>', 'Required modifier (e.g., async, export)')
    .option('-c, --contains <text>', 'Text that must appear inside the matched node')
    .option('-n, --name-pattern <pattern>', 'Regex pattern for the node name')
    .option('-f, --file-patterns <patterns>', 'Comma-separated glob patterns for files to search')
    .option('--dry-run', 'Preview changes without writing to disk', true)
    .option('--no-dry-run', 'Actually write changes to disk')
    .action(
      asyncHandler(
        async (opts: {
          kind: string;
          replacement: string;
          modifier?: string;
          contains?: string;
          namePattern?: string;
          filePatterns?: string;
          dryRun: boolean;
        }) => {
          await withService(['scale'], async (ctx) => {
            const kg = ctx.kg;
            const files = kg.getAllFiles();
            const filePaths = files.map((f) => f.path);

            const searchOptions: StructuralSearchOptions = {
              nodeKind: opts.kind,
              hasModifier: opts.modifier,
              containsText: opts.contains,
              namePattern: opts.namePattern,
              filePatterns: opts.filePatterns?.split(',').map((p) => p.trim()),
              maxResults: 50,
            };

            const replaceOptions: StructuralReplaceOptions = {
              ...searchOptions,
              replacement: opts.replacement,
              dryRun: opts.dryRun,
            };

            const result = searcher.replace(replaceOptions, filePaths);

            if (result.replaced === 0) {
              output.warn('No matches found to replace.');
              return;
            }

            output.section(`Structural Replace: ${opts.kind} → ${opts.replacement}`);
            output.kv('Mode', result.dryRun ? 'dry-run' : 'write');
            output.kv('Replaced', String(result.replaced));
            output.kv('Files', String(result.files.length));

            if (result.dryRun) {
              output.info('This was a dry run. Use --no-dry-run to apply changes.');
            } else {
              output.success(
                `Replaced ${result.replaced} occurrences in ${result.files.length} files`,
              );
            }
          });
        },
      ),
    );

  return structuralSearchCmd;
}
