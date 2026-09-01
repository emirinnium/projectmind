import { z } from 'zod';
import { existsSync } from 'node:fs';
import ts from 'typescript';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { createProjectLanguageService } from '@/cli/utils/language-service.js';
import { confineToProject } from './_shared.js';

/**
 * find_symbol_references — locate every reference of a symbol in a file using
 * the REAL TypeScript language service (not string matching).
 *
 * This is the MCP twin of the `pm refs` CLI command (src/cli/commands/refs.ts).
 * It builds a project language service over `deps.projectRoot` (resolving
 * through the project tsconfig so imports, aliases and type positions count),
 * locates the symbol in the given file, and returns every definition +
 * reference as `{ file, line, column, snippet, isWriteAccess }`.
 *
 * The declaration-locating and span-describing helpers are replicated here
 * (they are module-private in refs.ts, not exported) so the tool stays
 * self-contained and directly unit-testable.
 */

/** Input accepted by the find_symbol_references tool. */
export interface FindSymbolReferencesArgs {
  file: string;
  symbol: string;
  max?: number;
}

/** A single definition or reference of the symbol. */
export interface SymbolReferenceResult {
  file: string;
  line: number;
  column: number;
  snippet: string;
  isWriteAccess: boolean;
}

/** Result of a find_symbol_references run. */
export interface FindSymbolReferencesResult {
  symbol: string;
  file: string;
  references: SymbolReferenceResult[];
  total: number;
}

/**
 * Prefer a declaration-style occurrence (class X / function X / const X ...),
 * else the first whole-word hit. Mirrors `pickDeclarationPosition` in
 * src/cli/commands/refs.ts (which is not exported, so it is replicated here).
 * Returns the character offset, or -1 when the symbol is not found.
 */
function pickDeclarationPosition(sourceText: string, symbol: string): number {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declPattern = new RegExp(
    `\\b(?:class|interface|function|enum|type|const|let|var)\\s+${escaped}\\b`,
  );
  const declMatch = declPattern.exec(sourceText);
  if (declMatch) return declMatch.index;

  const wordPattern = new RegExp(`\\b${escaped}\\b`);
  const anyMatch = wordPattern.exec(sourceText);
  return anyMatch ? anyMatch.index : -1;
}

/** Resolve a character offset to 1-based line/column plus a trimmed snippet.
 *  Mirrors `describeSpan` in src/cli/commands/refs.ts. */
function describeSpan(
  text: string,
  start: number,
): { line: number; column: number; snippet: string } {
  const before = text.slice(0, start);
  const line = before.split(/\r?\n/).length;
  const lastNewline = before.lastIndexOf('\n');
  const column = start - lastNewline;
  const lineStart = lastNewline + 1;
  const lineEnd = text.indexOf('\n', start);
  const rawLine = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  return { line, column, snippet: rawLine.trim().slice(0, 120) };
}

/**
 * Find all references of `symbol` in `file` via the real TypeScript language
 * service over `deps.projectRoot`.
 *
 * Pure and dependency-light (only `deps.projectRoot` is read), so it is
 * directly unit-testable — mirroring the `evaluateContracts` /
 * `semanticSearchForTool` pattern of exporting the core logic for tests.
 *
 * @throws {Error} When the file is missing, the project has no usable
 *   tsconfig.json, or the symbol is not found as a whole word in the file.
 */
export function findSymbolReferencesForTool(
  deps: McpDependencies,
  args: FindSymbolReferencesArgs,
): FindSymbolReferencesResult {
  const absPath = confineToProject(args.file, deps.projectRoot);

  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }

  const ls = createProjectLanguageService(deps.projectRoot, [absPath]);
  if (!ls) {
    throw new Error('No usable tsconfig.json at project root — language-service unavailable.');
  }

  try {
    const targetFile = ls.norm(absPath);
    const sourceText = ts.sys.readFile(targetFile) ?? '';
    const position = pickDeclarationPosition(sourceText, args.symbol);
    if (position < 0) {
      throw new Error(`Symbol "${args.symbol}" not found as a whole word in ${args.file}.`);
    }

    const referencedSymbols = ls.service.findReferences(targetFile, position) ?? [];
    const max = args.max ?? 40;
    const references: SymbolReferenceResult[] = [];
    let total = 0;

    for (const refSym of referencedSymbols) {
      for (const ref of [refSym.definition, ...refSym.references]) {
        total++;
        if (references.length >= max) continue;
        const sfPath = ref.fileName.replace(/\\/g, '/');
        const sfText = ts.sys.readFile(ref.fileName) ?? '';
        const { line, column, snippet } = describeSpan(sfText, ref.textSpan.start);
        references.push({
          file: sfPath,
          line,
          column,
          snippet,
          isWriteAccess: 'isWriteAccess' in ref && ref.isWriteAccess === true,
        });
      }
    }

    return {
      symbol: args.symbol,
      file: args.file,
      references,
      total,
    };
  } finally {
    ls.dispose();
  }
}

export function registerFindSymbolReferencesTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'find_symbol_references',
    {
      title: 'Find Symbol References',
      description:
        'Find every reference of a symbol in a file using the real TypeScript language service (not string matching).\n' +
        'WHEN to call: when you need to know everywhere a symbol is read or written (with file:line and whether it is a write access), ' +
        'e.g. before renaming a function, assessing dead code, or understanding the blast radius of a change.\n' +
        'Resolves through the project tsconfig so imports, aliases and type positions count.',
      inputSchema: {
        file: z
          .string()
          .describe(
            'Path of the file containing the symbol (relative to project root or absolute in-project)',
          ),
        symbol: z
          .string()
          .describe('Symbol name to locate (e.g. a function, class, const or type name)'),
        max: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum references to return (default 40)'),
      },
    },
    async (args) => {
      try {
        const result = findSymbolReferencesForTool(deps, {
          file: args.file,
          symbol: args.symbol,
          max: args.max,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );
}
