import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';
import { StructuralSearcher, type StructuralSearchOptions, type StructuralReplaceOptions } from '@/parser/structural-search.js';

const searcher = new StructuralSearcher();

export function registerStructuralSearchTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'structural_search',
    {
      title: 'Structural Search',
      description: 'Find and optionally rewrite code by AST pattern. Matches AST nodes across TypeScript, JavaScript, Python, Go, Rust, and Java.',
      inputSchema: {
        nodeKind: z.string().describe('AST node kind to match (e.g., FunctionDeclaration, CallExpression, IfStatement; for non-TS languages use tree-sitter node types like function_definition, function_declaration, function_item, method_declaration)'),
        hasModifier: z.string().optional().describe('Required modifier (e.g., async, export; Java-only for non-TS languages)'),
        containsText: z.string().optional().describe('Text that must appear inside the matched node'),
        namePattern: z.string().optional().describe('Regex pattern for the node name (functions, classes, etc.)'),
        filePatterns: z.array(z.string()).optional().describe('Glob patterns for files to search'),
        maxResults: z.number().default(50).describe('Maximum number of results'),
        replacement: z.string().optional().describe('Replacement text (if provided, performs replace instead of search)'),
        dryRun: z.boolean().default(true).describe('If true, do not write changes to disk'),
        language: z.enum(['typescript', 'javascript', 'python', 'go', 'rust', 'java']).optional().describe('Language to search (defaults to per-file extension detection)'),
      },
    },
    async (args) => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'structural-search');
        }

        const files = deps.kg.getAllFiles();
        const filePaths = files.map((f) => f.path);

        const searchOptions: StructuralSearchOptions = {
          nodeKind: args.nodeKind,
          hasModifier: args.hasModifier,
          containsText: args.containsText,
          namePattern: args.namePattern,
          filePatterns: args.filePatterns,
          maxResults: args.maxResults,
          language: args.language,
        };

        if (args.replacement) {
          const replaceOptions: StructuralReplaceOptions = {
            ...searchOptions,
            replacement: args.replacement,
            dryRun: args.dryRun,
          };

          const result = searcher.replace(replaceOptions, filePaths);

          // Truncate diffs to avoid overwhelming the client — include only
          // the first 3 files and cap each file's diff at 2000 chars.
          const MAX_DIFFS = 3;
          const MAX_DIFF_CHARS = 2000;
          const truncatedDiffs = result.diffs.slice(0, MAX_DIFFS).map((d) => ({
            file: d.filePath,
            originalPreview: d.original.substring(0, MAX_DIFF_CHARS) + (d.original.length > MAX_DIFF_CHARS ? '…' : ''),
            transformedPreview: d.transformed.substring(0, MAX_DIFF_CHARS) + (d.transformed.length > MAX_DIFF_CHARS ? '…' : ''),
          }));

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  mode: 'replace',
                  success: true,
                  replaced: result.replaced,
                  files: result.files,
                  dryRun: result.dryRun,
                  message: result.dryRun
                    ? `Would replace ${result.replaced} occurrences in ${result.files.length} files`
                    : `Replaced ${result.replaced} occurrences in ${result.files.length} files`,
                  ...(result.dryRun ? { diffs: truncatedDiffs, totalDiffs: result.diffs.length } : {}),
                }, null, 2),
              },
            ],
          };
        } else {
          const matches = searcher.search(searchOptions, filePaths);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  mode: 'search',
                  success: true,
                  totalMatches: matches.length,
                  matches: matches.map((m) => ({
                    file: m.filePath,
                    lines: `${m.startLine}-${m.endLine}`,
                    kind: m.nodeKind,
                    snippet: m.text.substring(0, 200) + (m.text.length > 200 ? '...' : ''),
                  })),
                }, null, 2),
              },
            ],
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }, null, 2),
            },
          ],
        };
      }
    }
  );
}
