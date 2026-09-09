import { Command } from 'commander';
import { asyncHandler, loadConfig, output } from '@/cli/utils/shared.js';
import { AutoFixEngine } from '@/core/refactor/auto-fix.js';
import { confineToProject } from '@/mcp/tools/_shared.js';
import { readFileSync } from 'node:fs';

export function createRefactorCommand(): Command {
  const refactorCmd = new Command('refactor').description('Code refactoring helpers');

  refactorCmd.action(() => {
    refactorCmd.outputHelp();
  });

  refactorCmd
    .command('organize-imports <file>')
    .description('Organize imports in a file (basic)')
    .option('--dry-run', 'Show changes without applying')
    .action(
      asyncHandler(async (file: string, opts: { dryRun?: boolean }) => {
        const root = loadConfig().projectRoot;
        const absolutePath = confineToProject(file, root);
        const result = new AutoFixEngine(root).run('organize-imports', absolutePath, {
          write: !opts.dryRun,
        });

        output.section(`Organize Imports: ${file}`);
        if (!result.changed) {
          output.success('Imports are already organized or the file is not safe to rewrite.');
          return;
        }
        output.info(result.diff ?? '');
        if (result.written) output.success('Imports organized');
        else output.info('DRY RUN — no changes written.');
      }),
    );

  refactorCmd
    .command('remove-unused <file>')
    .description('Report potentially unused imports (basic)')
    .action(
      asyncHandler(async (file: string) => {
        const root = loadConfig().projectRoot;
        const absolutePath = confineToProject(file, root);
        output.section(`Check Unused Imports: ${file}`);

        const content = readFileSync(absolutePath, 'utf-8');
        const { importedNames, codeWithoutImports } = collectImportedBindings(content);
        const unused = [...importedNames].filter(
          (name) => !new RegExp(`\\b${escapeRegExp(name)}\\b`).test(codeWithoutImports),
        );

        if (unused.length === 0) {
          output.success('No unused imports detected');
        } else {
          output.warn(`Potentially unused: ${unused.join(', ')}`);
          output.info('Verify manually before removing');
        }
      }),
    );

  refactorCmd
    .command('autofix <file>')
    .description('AST-based mechanical fixes with diff preview (preview-only unless --apply)')
    .option(
      '--fixer <id>',
      'organize-imports | dedupe-imports | remove-unused-imports | all',
      'all',
    )
    .option('--apply', 'Write changes to disk (default: preview only)')
    .action(
      asyncHandler(async (file: string, opts: { fixer?: string; apply?: boolean }) => {
        const root = loadConfig().projectRoot;
        const absolutePath = confineToProject(file, root);
        const engine = new AutoFixEngine(root);

        if (!opts.fixer || opts.fixer === 'list') {
          output.section('Available Fixers');
          for (const f of engine.listFixers()) output.kv(f.id, f.description);
          return;
        }

        const result = engine.run(opts.fixer ?? 'all', absolutePath, { write: !!opts.apply });

        output.section(`AutoFix: ${file}`);
        output.kv('Fixer', result.fixer);
        if (!result.changed) {
          output.success(result.reason ?? 'nothing to do');
          return;
        }
        output.info(result.diff ?? '');
        if (result.written) {
          output.success('Applied (written to disk). Review with your VCS before committing.');
        } else {
          output.warn('PREVIEW ONLY — re-run with --apply to persist.');
        }
      }),
    );

  return refactorCmd;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectImportedBindings(content: string): {
  importedNames: Set<string>;
  codeWithoutImports: string;
} {
  const importedNames = new Set<string>();
  const importRegex = /^\s*import\s+(?!type\s+)([\s\S]*?)\s+from\s+["'][^"']+["']\s*;?\s*$/gm;
  const importTypeRegex = /^\s*import\s+type\s+([\s\S]*?)\s+from\s+["'][^"']+["']\s*;?\s*$/gm;

  for (const match of content.matchAll(importRegex)) addBindings(match[1], importedNames);
  for (const match of content.matchAll(importTypeRegex)) addBindings(match[1], importedNames);

  return {
    importedNames,
    codeWithoutImports: content.replace(importRegex, '').replace(importTypeRegex, ''),
  };
}

function addBindings(specifier: string, names: Set<string>): void {
  const named = specifier.match(/{([\s\S]*)}/)?.[1];
  if (named) {
    for (const part of named.split(',')) {
      const local = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (local && /^[$A-Z_a-z][$\w]*$/.test(local)) names.add(local);
    }
  }

  const namespace = specifier.match(/\*\s+as\s+([$A-Z_a-z][$\w]*)/);
  if (namespace) names.add(namespace[1]);

  const defaultPart = specifier.split('{')[0].split(',')[0].trim();
  if (defaultPart && !defaultPart.startsWith('*') && /^[$A-Z_a-z][$\w]*$/.test(defaultPart)) {
    names.add(defaultPart);
  }
}
