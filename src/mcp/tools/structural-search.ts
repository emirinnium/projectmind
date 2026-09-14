import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import fg from 'fast-glob';
import { trackAgentAccess } from './types.js';
import {
  StructuralSearcher,
  type StructuralSearchOptions,
  type StructuralReplaceOptions,
} from '@/parser/structural-search.js';
import { assertProjectPath } from '@/core/security/path-security.js';
import { asUntrustedContent } from '@/mcp/security/untrusted-content.js';
import { getProjectIgnorePatterns } from '@/utils/ignore.js';

const searcher = new StructuralSearcher();

function normalizeAbsolutePath(filePath: string): string {
  const normalized = resolve(filePath).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Resolve user-provided glob filters without reading source content. The
 * resulting set is only used to narrow the already-indexed file list; every
 * selected path still passes the central path-security contract below.
 */
function resolveFilePatternMatches(projectRoot: string, patterns: string[]): Set<string> {
  const matches = fg.sync(patterns, {
    cwd: projectRoot,
    absolute: true,
    onlyFiles: true,
    dot: true,
    unique: true,
    ignore: getProjectIgnorePatterns(projectRoot),
  });
  return new Set(matches.map((filePath) => normalizeAbsolutePath(filePath)));
}

export function registerStructuralSearchTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'structural_search',
    {
      title: 'Structural Search',
      description: 'Find and optionally rewrite TypeScript or JavaScript code by AST pattern.',
      inputSchema: {
        nodeKind: z
          .string()
          .describe(
            'AST node kind to match (e.g., FunctionDeclaration, CallExpression, IfStatement)',
          ),
        hasModifier: z.string().optional().describe('Required modifier (e.g., async, export)'),
        containsText: z
          .string()
          .optional()
          .describe('Text that must appear inside the matched node'),
        namePattern: z
          .string()
          .optional()
          .describe('Regex pattern for the node name (functions, classes, etc.)'),
        filePatterns: z.array(z.string()).optional().describe('Glob patterns for files to search'),
        maxResults: z.number().default(50).describe('Maximum number of results'),
        replacement: z
          .string()
          .optional()
          .describe('Replacement text (if provided, performs replace instead of search)'),
        dryRun: z.boolean().default(true).describe('If true, do not write changes to disk'),
        language: z
          .enum(['typescript', 'javascript'])
          .optional()
          .describe('Language to search (defaults to per-file extension detection)'),
      },
    },
    async (args) => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'structural-search');
        }

        const files = deps.kg.getAllFiles();
        const patternMatches =
          args.filePatterns && args.filePatterns.length > 0
            ? resolveFilePatternMatches(deps.projectRoot, args.filePatterns)
            : null;
        const filePaths = files.flatMap((file) => {
          const candidate = file.relativePath || file.path;
          if (
            patternMatches &&
            !patternMatches.has(normalizeAbsolutePath(resolve(deps.projectRoot, candidate)))
          ) {
            return [];
          }
          try {
            return [
              assertProjectPath(candidate, deps.projectRoot, {
                mustExist: true,
                rejectIgnored: true,
              }),
            ];
          } catch {
            return [];
          }
        });

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
            originalPreview:
              d.original.substring(0, MAX_DIFF_CHARS) +
              (d.original.length > MAX_DIFF_CHARS ? '…' : ''),
            transformedPreview:
              d.transformed.substring(0, MAX_DIFF_CHARS) +
              (d.transformed.length > MAX_DIFF_CHARS ? '…' : ''),
            originalUntrustedContent: asUntrustedContent(
              d.original.substring(0, MAX_DIFF_CHARS),
              'source',
              { relativePath: relative(deps.projectRoot, d.filePath).replace(/\\/g, '/') },
            ),
            transformedUntrustedContent: asUntrustedContent(
              d.transformed.substring(0, MAX_DIFF_CHARS),
              'source',
              { relativePath: relative(deps.projectRoot, d.filePath).replace(/\\/g, '/') },
            ),
          }));

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    mode: 'replace',
                    success: true,
                    replaced: result.replaced,
                    files: result.files,
                    dryRun: result.dryRun,
                    message: result.dryRun
                      ? `Would replace ${result.replaced} occurrences in ${result.files.length} files`
                      : `Replaced ${result.replaced} occurrences in ${result.files.length} files`,
                    ...(result.dryRun
                      ? { diffs: truncatedDiffs, totalDiffs: result.diffs.length }
                      : {}),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } else {
          const matches = searcher.search(searchOptions, filePaths);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    mode: 'search',
                    success: true,
                    totalMatches: matches.length,
                    matches: matches.map((m) => ({
                      file: m.filePath,
                      lines: `${m.startLine}-${m.endLine}`,
                      kind: m.nodeKind,
                      snippet: m.text.substring(0, 200) + (m.text.length > 200 ? '...' : ''),
                      untrustedContent: asUntrustedContent(m.text.substring(0, 200), 'source', {
                        relativePath: relative(deps.projectRoot, m.filePath).replace(/\\/g, '/'),
                      }),
                    })),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}
