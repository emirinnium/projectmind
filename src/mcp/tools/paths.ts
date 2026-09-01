import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { resolve, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { loadConfig } from '../../utils/config.js';

interface PathAlias {
  prefix: string;
  paths: string[];
}

function parseTsconfigAliases(tsconfigPath: string): PathAlias[] {
  try {
    const content = readFileSync(tsconfigPath, 'utf-8');
    const config = JSON.parse(content);
    const aliases: PathAlias[] = [];

    if (config.compilerOptions?.paths) {
      for (const [prefix, paths] of Object.entries(config.compilerOptions.paths)) {
        aliases.push({
          prefix: prefix.replace(/\*$/, ''),
          paths: (paths as string[]).map((p) => p.replace(/\*$/, '')),
        });
      }
    }
    return aliases;
  } catch {
    return [];
  }
}

function resolveWithAliases(
  importPath: string,
  aliases: PathAlias[],
  baseDir: string,
): string | null {
  for (const alias of aliases) {
    if (importPath.startsWith(alias.prefix)) {
      const remainder = importPath.slice(alias.prefix.length);
      for (const targetPath of alias.paths) {
        const candidate = resolve(baseDir, targetPath + remainder);
        // Only accept candidates that actually exist on disk — otherwise
        // fall through to remaining alias targets and later strategies.
        if (existsSync(candidate)) {
          return candidate.replace(/\\/g, '/');
        }
      }
    }
  }
  return null;
}

export function registerResolvePathTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'resolve_path',
    {
      title: 'Resolve Path',
      description:
        'Resolve a file path with TypeScript/JS module resolution rules (supports path aliases, index files, extensions).',
      inputSchema: {
        importPath: z.string().describe('The import path to resolve'),
        fromFilePath: z
          .string()
          .describe('The file containing the import (for relative resolution)'),
        tsconfigPath: z
          .string()
          .optional()
          .describe('Optional path to tsconfig.json for path aliases'),
      },
    },
    async (args) => {
      let importPath = args.importPath;
      const fromFile = deps.kg.getFileByPath(args.fromFilePath);

      if (!fromFile) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'From file not found in knowledge graph' }),
            },
          ],
        };
      }

      // Handle path aliases from tsconfig
      let aliases: PathAlias[] = [];
      if (args.tsconfigPath && existsSync(args.tsconfigPath)) {
        aliases = parseTsconfigAliases(args.tsconfigPath);
      } else {
        // Try to find tsconfig.json in project root
        const config = deps.kg.getFileByPath('tsconfig.json');
        if (config) {
          aliases = parseTsconfigAliases(config.path);
        }
      }

      // Try alias resolution first
      if (aliases.length > 0) {
        // Alias targets are relative to the project root, not the importing file's dir.
        const aliasResolved = resolveWithAliases(
          importPath,
          aliases,
          loadConfig().projectRoot.replace(/\\/g, '/'),
        );
        if (aliasResolved) {
          importPath = aliasResolved;
        }
      }

      // Try to resolve using knowledge graph
      let resolved = deps.kg.getFileByImport(importPath, args.fromFilePath);

      if (!resolved) {
        // Try manual resolution
        const fromDir = dirname(fromFile.relativePath).replace(/\\/g, '/');
        const resolvedPath = resolve(fromDir, importPath).replace(/\\/g, '/');
        resolved = deps.kg.resolveImportSource(resolvedPath);
      }

      if (!resolved) {
        // Try with extensions
        const extensions = [
          '.ts',
          '.tsx',
          '.js',
          '.jsx',
          '.mjs',
          '.cjs',
          '/index.ts',
          '/index.tsx',
          '/index.js',
          '/index.jsx',
        ];
        for (const ext of extensions) {
          const tryPath = importPath + ext;
          resolved = deps.kg.getFileByImport(tryPath, args.fromFilePath);
          if (resolved) break;
        }
      }

      if (!resolved) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  resolved: false,
                  importPath: args.importPath,
                  fromFile: fromFile.relativePath,
                  message: 'Could not resolve path',
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                resolved: true,
                importPath: args.importPath,
                fromFile: fromFile.relativePath,
                resolvedFile: {
                  path: resolved.relativePath,
                  language: resolved.language,
                  sizeBytes: resolved.sizeBytes,
                  cognitiveLoad: resolved.cognitiveLoad,
                  agentTouched: resolved.agentTouched,
                  imports: deps.kg.getImports(resolved.id).map((i) => i.source),
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

export function registerFindFileByImportTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'find_file_by_import',
    {
      title: 'Find File by Import',
      description:
        'Find all files that match an import pattern (useful for finding where a module is defined).',
      inputSchema: {
        pattern: z
          .string()
          .describe('Import pattern to search for (e.g., "react", "./utils", "@/components")'),
      },
    },
    async (args) => {
      const files = deps.kg.findFilesByImportPattern(args.pattern);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                pattern: args.pattern,
                matches: files.map((f) => ({
                  path: f.relativePath,
                  language: f.language,
                  sizeBytes: f.sizeBytes,
                  cognitiveLoad: f.cognitiveLoad,
                  agentTouched: f.agentTouched,
                })),
                count: files.length,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
