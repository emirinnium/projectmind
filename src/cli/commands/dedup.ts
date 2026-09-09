import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { CloneDetector } from '@/core/dedup/clone-detector.js';
import { isTestPath } from '@/utils/test-detection.js';

export function createDedupCommand(): Command {
  return new Command('dedup')
    .description('Find duplicate code with AST-based Type-2 clone detection')
    .option('-t, --type <type>', 'Legacy mode: filter debt items by type (e.g. redundancy)')
    .option('-m, --mode <mode>', 'Detection mode: ast (default) | debt', 'ast')
    .option('--min-lines <n>', 'AST mode: minimum function body lines', '6')
    .option('--limit <n>', 'AST mode: max groups to report', '20')
    .action(
      asyncHandler(
        async (opts: { type?: string; mode?: string; minLines?: string; limit?: string }) => {
          if (opts.mode !== 'ast' && opts.mode !== 'debt') {
            throw new Error(`--mode must be ast or debt: ${opts.mode}`);
          }
          if (opts.type && opts.type !== 'redundancy') {
            throw new Error(`--type currently supports only redundancy: ${opts.type}`);
          }
          if (opts.mode === 'ast') {
            await runAstDedup(opts);
            return;
          }
          await runDebtDedup(opts.type);
        },
      ),
    );
}

async function runAstDedup(opts: { minLines?: string; limit?: string }): Promise<void> {
  const minLines = Number.parseInt(opts.minLines ?? '6', 10);
  const limit = Number.parseInt(opts.limit ?? '20', 10);
  if (!Number.isSafeInteger(minLines) || minLines < 3 || minLines > 10_000) {
    throw new Error(`--min-lines must be an integer between 3 and 10000: ${opts.minLines}`);
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`--limit must be an integer between 1 and 1000: ${opts.limit}`);
  }

  await withService([], async (ctx) => {
    output.section('Clone Detection (AST, Type-2)');
    const files = ctx.kg
      .getAllFiles()
      .map((f) => f.relativePath || f.path)
      .filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(p))
      .filter((p) => !isTestPath(p));

    if (files.length === 0) {
      output.warn('No indexed JS/TS files. Run scan_project first.');
      return;
    }

    const detector = new CloneDetector(ctx.config.projectRoot);
    const result = detector.detect(files, { minLines, maxGroups: limit });

    output.kv(
      'Scanned',
      `${result.scannedFunctions} functions across ${result.scannedFiles} files`,
    );
    if (result.groups.length === 0) {
      output.success('No clone groups found');
      output.info(result.note);
      return;
    }
    for (const [i, group] of result.groups.entries()) {
      output.kv(
        `Group ${i + 1} (${group.size}x, ~${group.approxLines} lines)`,
        `fingerprint ${group.fingerprint}`,
      );
      for (const occ of group.occurrences.slice(0, 5)) {
        output.kv(`  · ${occ.filePath}:${occ.startLine}-${occ.endLine}`, occ.name);
      }
      if (group.occurrences.length > 5)
        output.info(`  … +${group.occurrences.length - 5} more occurrences`);
    }
    output.info(result.note);
  });
}

async function runDebtDedup(typeFilter?: string): Promise<void> {
  const type = typeFilter ?? 'redundancy';

  await withService(['debt'], async (_ctx, services) => {
    const debt = services.debt!;

    output.section('Code Deduplication (debt-based)');
    output.info(`Running debt detection to find ${type}...`);

    const items = await debt.detectDebt();
    const redundancyItems = items.filter((i) => i.type === type);

    if (redundancyItems.length === 0) {
      output.success(`No ${type} detected`);
      return;
    }

    output.section(`${type} Items (${redundancyItems.length})`);
    for (const [i, item] of redundancyItems.slice(0, 20).entries()) {
      output.kv(`${i + 1}. ${item.filePath || 'project-wide'}`, item.description);
      if (item.suggestion) output.kv('Suggestion', item.suggestion);
    }
    output.info('Legacy debt mode now reports only AST-confirmed Type-2 clone evidence.');
  });
}
