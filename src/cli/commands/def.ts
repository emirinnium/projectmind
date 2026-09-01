import { Command } from 'commander';
import { asyncHandler, output, loadConfig } from '@/cli/utils/shared.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { createProjectLanguageService } from '@/cli/utils/language-service.js';

/**
 * Go-to-definition for a symbol occurrence in a file — backed by the real
 * TypeScript language service (type-aware, alias-tolerant), complementing
 * `pm refs` (find references).
 */
export function createDefCommand(): Command {
  return new Command('def')
    .description('Go to definition of a symbol occurrence in a file (TypeScript language service)')
    .argument('<file>', 'File containing the symbol usage')
    .argument('<symbol>', 'Symbol name to locate')
    .action(
      asyncHandler(async (filePath: string, symbol: string) => {
        const root = loadConfig().projectRoot;

        if (!existsSync(resolve(root, filePath))) {
          output.warn(`File not found: ${resolve(root, filePath)}`);
          return;
        }

        const ls = createProjectLanguageService(root, [resolve(root, filePath)]);
        if (!ls) {
          output.warn('No usable tsconfig.json at project root — language service unavailable.');
          return;
        }

        output.section(`Definition of "${symbol}"`);
        output.kv('Usage in', filePath);

        try {
          const target = ls.norm(resolve(root, filePath));
          const sourceText = ts.sys.readFile(target) ?? '';
          const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const match = new RegExp(`\\b${escaped}\\b`).exec(sourceText);
          if (!match) {
            output.warn(`Symbol "${symbol}" not found as a whole word in ${filePath}.`);
            return;
          }

          const definitions = ls.service.getDefinitionAtPosition(target, match.index) ?? [];
          if (definitions.length === 0) {
            output.warn('No definition found — symbol may come from a dependency without sources.');
            return;
          }

          for (const d of definitions) {
            const defText = ts.sys.readFile(d.fileName) ?? '';
            const before = defText.slice(0, d.textSpan.start);
            const line = before.split(/\r?\n/).length;
            const lineStart = before.lastIndexOf('\n') + 1;
            const snippet = (defText.slice(lineStart).split(/\r?\n/)[0] ?? '').trim().slice(0, 140);
            output.kv(`  ${ls.norm(d.fileName)}:${line}`, snippet || d.name);
          }
          output.kv('Definitions', String(definitions.length));
        } finally {
          ls.dispose();
        }
      }),
    );
}
