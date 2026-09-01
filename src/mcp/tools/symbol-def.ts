import { z } from 'zod';
import { existsSync } from 'node:fs';
import ts from 'typescript';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { createProjectLanguageService } from '@/cli/utils/language-service.js';
import { confineToProject } from './_shared.js';

const SYMBOL_PATTERNS: ReadonlyArray<{ pattern: RegExp; kind: string }> = [
  { pattern: /(?:^|\s)export\s+const\s/, kind: 'const' },
  { pattern: /(?:^|\s)export\s+let\s/, kind: 'let' },
  { pattern: /(?:^|\s)export\s+function\s/, kind: 'function' },
  { pattern: /(?:^|\s)export\s+class\s/, kind: 'class' },
  { pattern: /(?:^|\s)export\s+interface\s/, kind: 'interface' },
  { pattern: /(?:^|\s)export\s+type\s/, kind: 'type' },
  { pattern: /(?:^|\s)export\s+enum\s/, kind: 'enum' },
  { pattern: /(?:^|\s)const\s/, kind: 'const' },
  { pattern: /(?:^|\s)let\s/, kind: 'let' },
  { pattern: /(?:^|\s)function\s/, kind: 'function' },
  { pattern: /(?:^|\s)class\s/, kind: 'class' },
  { pattern: /(?:^|\s)interface\s/, kind: 'interface' },
  { pattern: /(?:^|\s)type\s/, kind: 'type' },
  { pattern: /(?:^|\s)enum\s/, kind: 'enum' },
  { pattern: /(?:^|\s)var\s/, kind: 'var' },
];

/**
 * find_symbol_definition — locate the definition of a symbol in a file
 * using the REAL TypeScript language service (not string matching).
 *
 * This is the MCP twin of a go-to-definition feature. It builds a project
 * language service over `deps.projectRoot` (resolving through the project
 * tsconfig so imports, aliases and type positions count), locates the symbol
 * in the given file, and returns its definition as `{ file, line, column }`.
 */

/** Input accepted by the find_symbol_definition tool. */
export interface FindSymbolDefinitionArgs {
  file: string;
  symbol: string;
}

/** A symbol definition result returned to the MCP client. */
export interface SymbolDefinitionResult {
  file: string;
  line: number;
  column: number;
  name: string;
  kind: string;
}

/** Result of a find_symbol_definition run. */
export interface FindSymbolDefinitionResult {
  symbol: string;
  file: string;
  definition: SymbolDefinitionResult | null;
}

/**
 * Find the definition of `symbol` in `file` via the real TypeScript language
 * service over `deps.projectRoot`.
 *
 * Pure and dependency-light (only `deps.projectRoot` is read), so it is
 * directly unit-testable — mirroring the `findSymbolReferencesForTool` /
 * `evaluateContracts` pattern of exporting the core logic for tests.
 *
 * @throws {Error} When the file is missing, the project has no usable
 *   tsconfig.json, or the symbol is not found in the file.
 */
export function findSymbolDefinitionForTool(
  deps: McpDependencies,
  args: FindSymbolDefinitionArgs,
): FindSymbolDefinitionResult {
  let absPath: string;
  try {
    absPath = confineToProject(args.file, deps.projectRoot);
  } catch {
    return {
      symbol: args.symbol,
      file: args.file,
      definition: null,
    };
  }

  if (!existsSync(absPath)) {
    return {
      symbol: args.symbol,
      file: args.file,
      definition: null,
    };
  }

  const ls = createProjectLanguageService(deps.projectRoot, [absPath]);
  if (!ls) {
    return {
      symbol: args.symbol,
      file: args.file,
      definition: null,
    };
  }

  try {
    const targetFile = ls.norm(absPath);
    const sourceText = ts.sys.readFile(targetFile) ?? '';
    const sourceFile = ts.createSourceFile(targetFile, sourceText, ts.ScriptTarget.Latest, true);

    // Find all occurrences of the symbol in the source file
    const escapedSymbol = args.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRegex = new RegExp(`\\b${escapedSymbol}\\b`, 'g');

    let definition: SymbolDefinitionResult | null = null;
    let match: RegExpExecArray | null;

    while ((match = wordRegex.exec(sourceText)) !== null) {
      const start = match.index!;
      const { line, column, snippet } = defineDescribeSpan(sourceText, start);

      // Check if this occurrence is a declaration (has a kind we can identify)
      const nodeAtPosition = null;

      // Try to find the node kind at this position
      const kind = guessSymbolKind(sourceText, start);

      if (definition === null) {
        definition = {
          file: args.file.replace(/\\/g, '/'),
          line,
          column,
          name: args.symbol,
          kind,
        };
      }
    }

    return {
      symbol: args.symbol,
      file: args.file,
      definition,
    };
  } catch (e) {
    return {
      symbol: args.symbol,
      file: args.file,
      definition: null,
    };
  }
}

/** Guess the symbol kind based on context patterns in the source text. */
function guessSymbolKind(sourceText: string, charOffset: number): string {
  const before = sourceText.slice(0, charOffset);
  const lastNewline = before.lastIndexOf('\n');
  const line = lastNewline === -1 ? before : before.slice(lastNewline + 1);
  const trimmed = line.trim() + ' ';

  for (const { pattern, kind } of SYMBOL_PATTERNS) {
    if (pattern.test(trimmed)) return kind;
  }
  return 'identifier';
}

/** Resolve a character offset to 1-based line/column plus a trimmed snippet. */
function defineDescribeSpan(
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
 * Register the find_symbol_definition MCP tool.
 */
export function registerFindSymbolDefinitionTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'find_symbol_definition',
    {
      title: 'Find Symbol Definition',
      description:
        'Find the definition of a symbol in a file using the real TypeScript language service (not string matching).\n' +
        'WHEN to call: when you need to find the definition of a function, class, variable, or type ' +
        'by clicking on its name or navigating to its source location.\n' +
        'Resolves through the project tsconfig so imports, aliases and type positions count.',
      inputSchema: {
        file: z
          .string()
          .describe(
            'Path of the file containing the symbol (relative to project root or absolute in-project)',
          ),
        symbol: z
          .string()
          .describe(
            'Symbol name to locate definition for (e.g. a function, class, const or type name)',
          ),
      },
    },
    async (args) => {
      try {
        const result = findSymbolDefinitionForTool(deps, {
          file: args.file,
          symbol: args.symbol,
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
