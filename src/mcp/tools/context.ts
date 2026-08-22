import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';

export function registerGetContextTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'get_context',
    {
      title: 'Get File Context',
      description: 'Get relevant context for a file — similar files, patterns, imports, dependents, and architectural constraints.',
      inputSchema: {
        filePath: z.string().describe('Path of the file to get context for'),
        limit: z.number().default(5).describe('Maximum number of context items to return'),
        includeImports: z.boolean().default(true).describe('Include import/dependency information'),
        includeDependents: z.boolean().default(true).describe('Include reverse dependencies (files that import this file)'),
        includeSimilar: z.boolean().default(true).describe('Include similar files based on embeddings'),
      },
    },
    async (args) => {
      try {
        const file = deps.kg.getFileByPath(args.filePath);
        if (!file) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'File not found in knowledge graph. Run scan_project first.' }) }],
          };
        }

        // Track agent access for coverage
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, args.filePath);
        }

        // Get imports with resolution status
        const imports = deps.kg.getImportsWithDetails(file.id);
        const resolvedImports = imports.filter((i) => i.resolvedFile);
        const unresolvedImports = imports.filter((i) => !i.resolvedFile);

        // Get dependents (reverse dependencies)
        const dependents = args.includeDependents ? deps.kg.getDependents(file.id) : [];

        // Get similar files
        let similarFiles: typeof file[] = [];
        if (args.includeSimilar) {
          const fileEmbedding = deps.kg.getFileEmbedding ? deps.kg.getFileEmbedding(file.id) : null;
          if (fileEmbedding) {
            similarFiles = deps.kg.findSimilarFiles(fileEmbedding, 0.7, args.limit);
          }
        }

        // Get functions and classes
        const functions = deps.kg.getFunctions(file.id);
        const classes = deps.kg.getClasses(file.id);

        // Get circular dependencies involving this file
        const cycles = deps.kg.findCircularDependencies?.() || [];
        const fileCycles = cycles.filter((cycle) => cycle.includes(file.relativePath));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                file: {
                  path: file.relativePath,
                  language: file.language,
                  sizeBytes: file.sizeBytes,
                  cognitiveLoad: file.cognitiveLoad,
                  agentTouched: file.agentTouched,
                  agentTouchedBy: file.agentTouchedBy,
                  agentTouchedAt: file.agentTouchedAt,
                  lastScanned: file.lastScanned,
                  hash: file.hash,
                },
                imports: {
                  total: imports.length,
                  resolved: resolvedImports.length,
                  unresolved: unresolvedImports.length,
                  details: imports.map((i) => ({
                    source: i.source,
                    kind: i.kind,
                    resolved: !!i.resolvedFile,
                    resolvedPath: i.resolvedFile?.relativePath,
                  })),
                },
                dependents: dependents.map((d) => ({
                  path: d.relativePath,
                  cognitiveLoad: d.cognitiveLoad,
                  agentTouched: d.agentTouched,
                  agentTouchedBy: d.agentTouchedBy,
                })),
                similarFiles: similarFiles.map((f) => ({
                  path: f.relativePath,
                  language: f.language,
                  cognitiveLoad: f.cognitiveLoad,
                  agentTouched: f.agentTouched,
                })),
                structure: {
                  functions: functions.map((fn) => ({
                    name: fn.name,
                    signature: fn.signature,
                    complexity: fn.complexity,
                    startLine: fn.startLine,
                    endLine: fn.endLine,
                  })),
                  classes: classes.map((cls) => ({
                    name: cls.name,
                    methodsCount: cls.methodsCount,
                    propertiesCount: cls.propertiesCount,
                  })),
                },
                circularDependencies: fileCycles,
                patterns: file.patterns || [],
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                filePath: args.filePath,
              }, null, 2),
            },
          ],
        };
      }
    }
  );
}