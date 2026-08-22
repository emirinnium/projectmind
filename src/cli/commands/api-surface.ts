import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { loadConfig } from '@/cli/utils/shared.js';
import { writeFileSync } from 'node:fs';
import {
  ExportedSymbol,
  ApiDiff,
  extractApiSurface,
  getApiAtRef,
  computeDiff,
  generateMarkdownReport,
  getBreakingReason,
} from './api-surface-utils.js';

export function createApiSurfaceCommand(): Command {
  const apiCmd = new Command('api-surface')
    .description('Track public API surface changes')
    .option('--base <ref>', 'Base git ref for comparison', 'HEAD~1')
    .option('--head <ref>', 'Head git ref for comparison', 'HEAD')
    .option('--breaking-only', 'Show only breaking changes')
    .option('--since <version>', 'Compare since version tag')
    .option('--format <fmt>', 'Output: text|json|markdown', 'text')
    .option('-o, --output <file>', 'Write to file')
    .action(asyncHandler(async (opts: { base: string; head: string; breakingOnly: boolean; since: string; format: string; output: string }) => {
      await withService(['scale'], async (_ctx, services) => {
        const scale = services.scale!;
        const config = loadConfig();
        
        output.section('API Surface Analysis');
        output.kv('Base ref', opts.base);
        output.kv('Head ref', opts.head);
        
        const report = scale.getScaleReport();
        const allFiles = report.modules.flatMap(m => m.files || []);
        const tsFiles = allFiles.filter(f => f.language === 'typescript');
        
        // Extract current API surface
        const currentApi = await extractApiSurface(tsFiles, config.projectRoot);
        
        // Try to get base API from git
        let baseApi: ExportedSymbol[] = [];
        let hasBase = false;
        
        if (opts.since) {
          // Try to get from version tag
          baseApi = await getApiAtRef(opts.since, config.projectRoot);
          hasBase = baseApi.length > 0;
        } else {
          baseApi = await getApiAtRef(opts.base, config.projectRoot);
          hasBase = baseApi.length > 0;
        }
        
        let diff: ApiDiff | null = null;
        if (hasBase) {
          diff = computeDiff(baseApi, currentApi);
        }
        
        if (opts.format === 'json') {
          const result = { currentApi, baseApi: hasBase ? baseApi : null, diff };
          const content = JSON.stringify(result, null, 2);
          if (opts.output) {
            writeFileSync(opts.output, content);
            output.success(`Written to ${opts.output}`);
          } else {
            console.log(content);
          }
          return;
        }
        
        if (opts.format === 'markdown') {
          const content = generateMarkdownReport(currentApi, diff, hasBase);
          if (opts.output) {
            writeFileSync(opts.output, content);
            output.success(`Written to ${opts.output}`);
          } else {
            console.log(content);
          }
          return;
        }
        
        // Text format
        output.section(`Current API Surface (${currentApi.length} exports)`);
        
        // Group by type
        const byType = currentApi.reduce((acc, sym) => {
          if (!acc[sym.type]) acc[sym.type] = [];
          acc[sym.type].push(sym);
          return acc;
        }, {} as Record<string, ExportedSymbol[]>);
        
        for (const [type, symbols] of Object.entries(byType)) {
          output.kv(`  ${type}s (${symbols.length})`, '');
          for (const sym of symbols.slice(0, 10)) {
            const dep = sym.deprecated ? ' ⚠️ DEPRECATED' : '';
            const def = sym.isDefault ? ' (default)' : '';
            output.kv(`    ${sym.name}${def}${dep}`, `${sym.relativePath}${sym.signature ? ` :: ${sym.signature}` : ''}`);
          }
          if (symbols.length > 10) {
            output.kv(`    ... and ${symbols.length - 10} more`, '');
          }
        }
        
        if (diff && hasBase) {
          output.section(`API Diff vs ${opts.base}`);
          
          if (diff.added.length > 0) {
            output.kv(`✅ Added (${diff.added.length})`, '');
            for (const sym of diff.added.slice(0, 20)) {
              output.kv(`  + ${sym.name}`, `${sym.relativePath}`);
            }
          }
          
          if (diff.removed.length > 0) {
            output.kv(`❌ Removed (${diff.removed.length})`, '');
            for (const sym of diff.removed.slice(0, 20)) {
              output.kv(`  - ${sym.name}`, `${sym.relativePath}`);
            }
          }
          
          if (diff.changed.length > 0) {
            output.kv(`🔄 Changed (${diff.changed.length})`, '');
            for (const { old, changes } of diff.changed.slice(0, 15)) {
              output.kv(`  ~ ${old.name}`, `${old.relativePath} | ${changes.join(', ')}`);
            }
          }
          
          if (diff.breaking.length > 0) {
            output.kv(`💥 Breaking Changes (${diff.breaking.length})`, '');
            for (const sym of diff.breaking.slice(0, 15)) {
              output.kv(`  ! ${sym.name}`, `${sym.relativePath} - ${getBreakingReason(sym)}`);
            }
          }
          
          if (opts.breakingOnly && diff.breaking.length === 0) {
            output.success('No breaking changes detected!');
          }
        } else {
          output.info('No base reference available for diff. Use --base or --since to compare.');
        }
        
        if (opts.output) {
          const content = JSON.stringify({ currentApi, baseApi: hasBase ? baseApi : null, diff }, null, 2);
          writeFileSync(opts.output, content);
          output.success(`Data written to ${opts.output}`);
        }
      });
    }));
  
  return apiCmd;
}
