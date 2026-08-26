import { Command } from 'commander';
import { asyncHandler, output } from '@/cli/utils/shared.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { AutoFixEngine } from '@/core/refactor/auto-fix.js';

export function createRefactorCommand(): Command {
  const refactorCmd = new Command('refactor')
    .description('Code refactoring helpers')
    .option('--dry-run', 'Show changes without applying');

  refactorCmd
    .command('organize-imports <file>')
    .description('Organize imports in a file (basic)')
    .action(asyncHandler(async (file: string, opts: { dryRun: boolean }) => {
      output.section(`Organize Imports: ${file}`);
      
      const content = readFileSync(file, 'utf-8');
      
      const lines = content.split('\n');
      const imports: string[] = [];
      const other: string[] = [];
      let inImports = false;
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('import ') || trimmed.startsWith('export {')) {
          imports.push(line);
          inImports = true;
        } else if (inImports && trimmed === '') {
          imports.push(line);
        } else {
          inImports = false;
          other.push(line);
        }
      }
      
      imports.sort((a, b) => {
        const aExt = a.includes('from "') || a.includes("from '");
        const bExt = b.includes('from "') || b.includes("from '");
        if (aExt && !bExt) return -1;
        if (!aExt && bExt) return 1;
        return a.localeCompare(b);
      });
      
      const newContent = [...imports, ...other].join('\n');
      
      if (opts.dryRun) {
        output.info('DRY RUN - showing diff:');
        const diff = generateDiff(content, newContent);
        console.log(diff);
      } else {
        writeFileSync(file, newContent);
        output.success('Imports organized');
      }
    }));

  refactorCmd
    .command('remove-unused <file>')
    .description('Report potentially unused imports (basic)')
    .action(asyncHandler(async (file: string) => {
      output.section(`Check Unused Imports: ${file}`);
      
      const content = readFileSync(file, 'utf-8');
      
      const importRegex = /import\s+(?:(?:\*|[^{}\n]+)\s+as\s+)?(?:\w+(?:\s*,\s*\w+)*)?(?:\s*{\s*([^}]+)\s*})?\s+from\s+["'][^"']+["']/g;
      let match;
      const importedNames = new Set<string>();
      
      while ((match = importRegex.exec(content)) !== null) {
        if (match[1]) {
          match[1].split(',').map(s => s.trim()).forEach(n => importedNames.add(n));
        }
      }
      
      const used = new Set<string>();
      for (const name of importedNames) {
        const usageRegex = new RegExp(`\\b${name}\\b`, 'g');
        if (usageRegex.test(content)) {
          used.add(name);
        }
      }
      
      const unused = [...importedNames].filter(n => !used.has(n));
      
      if (unused.length === 0) {
        output.success('No unused imports detected');
      } else {
        output.warn(`Potentially unused: ${unused.join(', ')}`);
        output.info('Verify manually before removing');
      }
    }));

  refactorCmd
    .command('autofix <file>')
    .description('AST-based mechanical fixes with diff preview (preview-only unless --apply)')
    .option('--fixer <id>', 'organize-imports | dedupe-imports | remove-unused-imports | all', 'all')
    .option('--apply', 'Write changes to disk (default: preview only)')
    .action(asyncHandler(async (file: string, opts: { fixer?: string; apply?: boolean }) => {
      const engine = new AutoFixEngine(process.cwd());

      if (!opts.fixer || opts.fixer === 'list') {
        output.section('Available Fixers');
        for (const f of engine.listFixers()) output.kv(f.id, f.description);
        return;
      }

      const result = engine.run(opts.fixer ?? 'all', file, { write: !!opts.apply });

      output.section(`AutoFix: ${file}`);
      output.kv('Fixer', result.fixer);
      if (!result.changed) {
        output.success(result.reason ?? 'nothing to do');
        return;
      }
      console.log(result.diff ?? '');
      if (result.written) {
        output.success('Applied (written to disk). Review with your VCS before committing.');
      } else {
        output.warn('PREVIEW ONLY — re-run with --apply to persist.');
      }
    }));

  return refactorCmd;
}

function generateDiff(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const maxLen = Math.max(oldLines.length, newLines.length);
  const diff: string[] = [];
  
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine !== newLine) {
      if (oldLine !== undefined) diff.push(`- ${oldLine}`);
      if (newLine !== undefined) diff.push(`+ ${newLine}`);
    }
  }
  return diff.join('\n');
}