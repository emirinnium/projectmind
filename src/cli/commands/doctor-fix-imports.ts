import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { getStatement } from '../../storage/database.js';
import { AliasResolver, getDefaultAliasResolver } from '../../parser/alias-resolver.js';
import { IntegrityGuard } from '../../core/kg/integrity-guard.js';

export function generateAliasSuggestions(
  rows: Array<{ file: string; src: string; kind: string }>,
  aliasResolver: AliasResolver,
): Array<{ prefix: string; target: string; exampleImport: string }> {
  const suggestions: Array<{ prefix: string; target: string; exampleImport: string }> = [];
  const existingAliases = aliasResolver.getAliases();
  const existingPrefixes = new Set(existingAliases.map((a) => a.prefix));

  // Group imports by common prefixes (e.g., 'src/', 'components/')
  const prefixCounts = new Map<string, { count: number; example: string }>();

  for (const row of rows) {
    // Skip relative imports, node builtins, dynamic imports, and JSON modules
    if (
      row.src.startsWith('./') ||
      row.src.startsWith('../') ||
      row.src.startsWith('node:') ||
      row.kind === 'dynamic-import' ||
      row.kind === 'json'
    ) {
      continue;
    }

    // Skip if already matches an existing alias
    let matchesExisting = false;
    for (const prefix of existingPrefixes) {
      if (row.src.startsWith(prefix)) {
        matchesExisting = true;
        break;
      }
    }
    if (matchesExisting) continue;

    // Extract potential prefix (first path segment)
    const parts = row.src.split('/');
    if (parts.length >= 2) {
      const potentialPrefix = parts[0] + '/';
      // Only suggest if it looks like a directory prefix (not a package scope)
      if (!potentialPrefix.startsWith('@')) {
        const current = prefixCounts.get(potentialPrefix) ?? { count: 0, example: row.src };
        current.count++;
        prefixCounts.set(potentialPrefix, current);
      }
    }
  }

  // Generate suggestions for prefixes that appear multiple times
  for (const [prefix, info] of prefixCounts) {
    if (info.count >= 2) {
      // Suggest mapping to src/ directory as a convention
      suggestions.push({
        prefix,
        target: `src/${prefix}`,
        exampleImport: info.example,
      });
    }
  }

  return suggestions;
}

export function createDoctorFixImportsCommand(): Command {
  return new Command('fix-imports')
    .description('Analyze unresolved imports and suggest alias/path fixes')
    .option('--limit <n>', 'Max files to show', '25')
    .option('--suggest-aliases', 'Generate alias suggestions for unresolved imports', false)
    .option('--repair-graph', 'Repair stale knowledge-graph nodes after reporting', false)
    .action(
      asyncHandler(
        async (opts: { limit?: string; suggestAliases?: boolean; repairGraph?: boolean }) => {
          const limit = Number.parseInt(opts.limit ?? '25', 10);
          if (!Number.isInteger(limit) || limit <= 0) {
            throw new Error(`--limit must be a positive integer: ${opts.limit}`);
          }
          await withService(['scale'], async (ctx, _services) => {
            output.section('Unresolved Imports Analysis');

            // Real data: every import recorded as unresolved during scan.
            const rows = getStatement(
              `SELECT f.relative_path AS file, i.source AS src, i.kind AS kind
           FROM imports i JOIN files f ON f.id = i.file_id
           WHERE f.project_id = ? AND i.resolved = 0
           ORDER BY f.relative_path`,
            ).all(ctx.kg.getCurrentProjectId()) as Array<{
              file: string;
              src: string;
              kind: string;
            }>;

            if (rows.length === 0) {
              output.success('All imports are resolved. Nothing to fix.');
              return;
            }

            // Use the AliasResolver for comprehensive alias resolution
            const aliasResolver = getDefaultAliasResolver();
            const aliases = aliasResolver.getAliases();

            // Group by file and produce suggestions.
            const byFile = new Map<
              string,
              Array<{ source: string; hint: string; suggestion?: string }>
            >();
            let aliasFixable = 0;
            let dynamicImportCount = 0;
            let jsonModuleCount = 0;

            for (const r of rows) {
              const list = byFile.get(r.file) ?? [];
              let hint = '';
              let suggestion: string | undefined;

              // Track import kinds
              if (r.kind === 'dynamic-import') {
                dynamicImportCount++;
              } else if (r.kind === 'json') {
                jsonModuleCount++;
              }

              // Try alias resolution for bare imports
              if (
                !r.src.startsWith('./') &&
                !r.src.startsWith('../') &&
                !r.src.startsWith('node:')
              ) {
                const aliasResult = aliasResolver.resolveAlias(r.src);
                if (aliasResult.matched) {
                  aliasFixable++;
                  hint = `alias match: ${aliasResult.resolvedCandidates.join(', ')}`;
                  if (opts.suggestAliases && aliasResult.resolvedCandidates.length > 0) {
                    suggestion = `Consider adding to tsconfig paths: "${r.src}" -> "${aliasResult.resolvedCandidates[0]}"`;
                  }
                }
              }

              if (!hint) {
                if (r.src.startsWith('node:')) {
                  hint = 'node built-in (resolved)';
                } else if (r.kind === 'dynamic-import') {
                  hint = 'dynamic import - verify at runtime';
                } else if (r.kind === 'json') {
                  hint = 'JSON module - verify file exists';
                } else if (/^[./]/.test(r.src)) {
                  hint = 'relative — check file exists / extension';
                } else {
                  hint = 'external package';
                }
              }

              list.push({ source: r.src, hint, suggestion });
              byFile.set(r.file, list);
            }

            output.kv('Files affected', byFile.size);
            output.kv('Unresolved imports', rows.length);
            output.kv('Alias-fixable', aliasFixable);
            if (dynamicImportCount > 0) output.kv('Dynamic imports', dynamicImportCount);
            if (jsonModuleCount > 0) output.kv('JSON modules', jsonModuleCount);

            // Show current aliases if any
            if (aliases.length > 0) {
              output.section('Configured Aliases');
              for (const a of aliases.slice(0, 10)) {
                output.kv(a.prefix, a.targets.join(', '));
              }
              if (aliases.length > 10) output.info(`... and ${aliases.length - 10} more aliases`);
            }

            output.section('Details');
            for (const [file, list] of [...byFile.entries()].slice(0, limit)) {
              output.kv(file, `${list.length} unresolved`);
              for (const l of list.slice(0, 5)) {
                output.warn(`   - ${l.source} (${l.hint})`);
                if (l.suggestion) output.info(`     → ${l.suggestion}`);
              }
            }
            if (byFile.size > limit) output.info(`…and ${byFile.size - limit} more files`);

            // Generate alias suggestions if requested
            if (opts.suggestAliases) {
              output.section('Alias Suggestions');
              const suggestedAliases = generateAliasSuggestions(rows, aliasResolver);
              if (suggestedAliases.length > 0) {
                output.info('Suggested tsconfig.json path entries:');
                for (const sug of suggestedAliases.slice(0, 10)) {
                  output.warn(`  "${sug.prefix}": ["${sug.target}"]`);
                  output.info(`    (for import: ${sug.exampleImport})`);
                }
              } else {
                output.info('No alias suggestions generated.');
              }
            }

            if (opts.repairGraph) {
              // This changes only the local knowledge graph, never source files.
              const guard = new IntegrityGuard(
                ctx.config.projectRoot,
                ctx.kg.getCurrentProjectId(),
              );
              const repaired = guard.repairStaleNodes();
              if (repaired > 0) {
                output.success(`Repaired ${repaired} stale graph node(s) via IntegrityGuard.`);
              } else {
                output.info('No stale graph nodes repaired.');
              }
            } else {
              output.info('Analysis mode — source imports and graph records were not modified.');
            }
          });
        },
      ),
    );
}
