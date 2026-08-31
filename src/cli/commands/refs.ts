import { Command } from 'commander';
import { asyncHandler, output } from '@/cli/utils/shared.js';
import { loadConfig } from '@/cli/utils/shared.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { createProjectLanguageService } from '@/cli/utils/language-service.js';

/**
 * Symbol-level cross-reference ("find all references") backed by the real
 * TypeScript language service — not string matching. Resolves through the
 * project tsconfig so imports, aliases and type positions count.
 */
export function createRefsCommand(): Command {
  return new Command('refs')
    .description('Find all references of a symbol in a file (TypeScript language service)')
    .argument('<file>', 'File containing the symbol')
    .argument('<symbol>', 'Symbol name to locate')
    .option('--max <n>', 'Maximum references to display', '40')
    .action(asyncHandler(async (filePath: string, symbol: string, opts: { max: string }) => {
      const root = loadConfig().projectRoot;

      if (!existsSync(resolve(root, filePath))) {
        output.warn(`File not found: ${resolve(root, filePath)}`);
        return;
      }

      output.section(`Finding references of "${symbol}"`);
      output.kv('File', filePath);
      output.info('Building language-service program (first run may take a few seconds)...');

      const ls = createProjectLanguageService(root, [resolve(root, filePath)]);
      if (!ls) {
        output.warn('No usable tsconfig.json at project root — language-service unavailable.');
        return;
      }
      try {
        const targetFile = ls.norm(resolve(root, filePath));
        const sourceText = ts.sys.readFile(targetFile) ?? '';
        const position = pickDeclarationPosition(sourceText, symbol);
        if (position < 0) {
          output.warn(`Symbol "${symbol}" not found as a whole word in ${filePath}.`);
          return;
        }

        const referencedSymbols = ls.service.findReferences(targetFile, position) ?? [];
        let shown = 0;
        let total = 0;

        for (const refSym of referencedSymbols) {
          for (const ref of [refSym.definition, ...refSym.references]) {
            total++;
            if (shown >= parseInt(opts.max, 10)) continue;
            const sfPath = ref.fileName.replace(/\\/g, '/');
            const sfText = ts.sys.readFile(ref.fileName) ?? '';
            const { line, column, snippet } = describeSpan(sfText, ref.textSpan.start);
            output.kv(
              `  ${sfPath}:${line}:${column}`,
              `${('isWriteAccess' in ref && ref.isWriteAccess) ? '✍️ write' : 'read'} | ${snippet}`
            );
            shown++;
          }
        }

        output.kv('Total references', String(total));
        if (total === 0) {
          output.info('No references found — symbol may be unused (candidate dead code).');
        }
      } finally {
        ls.dispose();
      }
    })
  );
}

/** Prefer a declaration-style occurrence (class X / function X / const X ...), else first word hit. */
function pickDeclarationPosition(sourceText: string, symbol: string): number {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declPattern = new RegExp(`\\b(?:class|interface|function|enum|type|const|let|var)\\s+${escaped}\\b`);
  const declMatch = declPattern.exec(sourceText);
  if (declMatch) return declMatch.index;

  const wordPattern = new RegExp(`\\b${escaped}\\b`);
  const anyMatch = wordPattern.exec(sourceText);
  return anyMatch ? anyMatch.index : -1;
}

function describeSpan(text: string, start: number): { line: number; column: number; snippet: string } {
  const before = text.slice(0, start);
  const line = before.split(/\r?\n/).length;
  const lastNewline = before.lastIndexOf('\n');
  const column = start - lastNewline;
  const lineStart = lastNewline + 1;
  const lineEnd = text.indexOf('\n', start);
  const rawLine = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  return { line, column, snippet: rawLine.trim().slice(0, 120) };
}
