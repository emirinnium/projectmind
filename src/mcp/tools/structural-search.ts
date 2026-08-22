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
      description: 'Find and optionally rewrite code by AST pattern. Matches TypeScript/JavaScript AST nodes across the codebase.',
      inputSchema: {
        nodeKind: z.string().describe('AST node kind to match (e.g., FunctionDeclaration, CallExpression, IfStatement)'),
        hasModifier: z.string().optional().describe('Required modifier (e.g., async, export)'),
        containsText: z.string().optional().describe('Text that must appear inside the matched node'),
        namePattern: z.string().optional().describe('Regex pattern for the node name (functions, classes, etc.)'),
        filePatterns: z.array(z.string()).optional().describe('Glob patterns for files to search'),
        maxResults: z.number().default(50).describe('Maximum number of results'),
        replacement: z.string().optional().describe('Replacement text (if provided, performs replace instead of search)'),
        dryRun: z.boolean().default(true).describe('If true, do not write changes to disk'),
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
        };

        if (args.replacement) {
          const replaceOptions: StructuralReplaceOptions = {
            ...searchOptions,
            replacement: args.replacement,
            dryRun: args.dryRun,
          };

          const result = searcher.replace(replaceOptions, filePaths);

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
