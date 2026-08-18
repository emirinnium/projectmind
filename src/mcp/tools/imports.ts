import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';

export function registerTraceImportsTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'trace_imports',
    {
      title: 'Trace Imports',
      description: 'Trace all transitive imports for a file to understand the full dependency tree.',
      inputSchema: {
        filePath: z.string().describe('Path of the file to trace imports for'),
        maxDepth: z.number().default(10).describe('Maximum depth to trace'),
      },
    },
    async (args) => {
      const file = deps.kg.getFileByPath(args.filePath);
      if (!file) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'File not found in knowledge graph. Run scan_project first.' }) }],
        };
      }

      const trace = deps.kg.traceImports(file.id, args.maxDepth);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              file: file.relativePath,
              imports: trace.map((t) => ({
                file: t.file.relativePath,
                depth: t.depth,
                importPath: t.path.join(' > '),
              })),
              totalDependencies: trace.length,
            }, null, 2),
          },
        ],
      };
    }
  );
}

export function registerFindCircularDepsTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'find_circular_deps',
    {
      title: 'Find Circular Dependencies',
      description: 'Find all circular dependencies in the project.',
      inputSchema: {},
    },
    async () => {
      const cycles = deps.kg.findCircularDependencies();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              cycles,
              count: cycles.length,
              message: cycles.length === 0 ? 'No circular dependencies found' : `Found ${cycles.length} circular dependenc${cycles.length === 1 ? 'y' : 'ies'}`,
            }, null, 2),
          },
        ],
      };
    }
  );
}

export function registerResolveImportTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'resolve_import',
    {
      title: 'Resolve Import',
      description: 'Resolve an import path to the actual file in the knowledge graph.',
      inputSchema: {
        importPath: z.string().describe('The import path to resolve (e.g., "./utils", "@/components/Button")'),
        fromFilePath: z.string().optional().describe('Optional: the file containing the import (for relative resolution)'),
      },
    },
    async (args) => {
      const file = deps.kg.getFileByImport(args.importPath, args.fromFilePath);
      if (!file) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ resolved: false, importPath: args.importPath, message: 'Could not resolve import' }) }],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              resolved: true,
              importPath: args.importPath,
              file: {
                path: file.relativePath,
                language: file.language,
                sizeBytes: file.sizeBytes,
                cognitiveLoad: file.cognitiveLoad,
                agentTouched: file.agentTouched,
              },
            }, null, 2),
          },
        ],
      };
    }
  );
}

export function registerGetDependentsTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'get_dependents',
    {
      title: 'Get Dependents',
      description: 'Find all files that import/depend on a given file (reverse dependencies).',
      inputSchema: {
        filePath: z.string().describe('Path of the file to find dependents for'),
      },
    },
    async (args) => {
      const file = deps.kg.getFileByPath(args.filePath);
      if (!file) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'File not found in knowledge graph. Run scan_project first.' }) }],
        };
      }

      const dependents = deps.kg.getDependents(file.id);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              file: file.relativePath,
              dependents: dependents.map((d) => ({
                path: d.relativePath,
                language: d.language,
                cognitiveLoad: d.cognitiveLoad,
                agentTouched: d.agentTouched,
              })),
              count: dependents.length,
            }, null, 2),
          },
        ],
      };
    }
  );
}

export function registerGetDependencyGraphTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'get_dependency_graph',
    {
      title: 'Get Dependency Graph',
      description: 'Get the dependency graph for a module/directory.',
      inputSchema: {
        modulePath: z.string().describe('Path of the module/directory (e.g., "src/core", "src/utils")'),
      },
    },
    async (args) => {
      const graph = deps.kg.getDependencyGraph(args.modulePath);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              module: args.modulePath,
              nodes: graph.nodes.map((n) => ({
                path: n.relativePath,
                language: n.language,
                cognitiveLoad: n.cognitiveLoad,
                agentTouched: n.agentTouched,
              })),
              edges: graph.edges,
              nodeCount: graph.nodes.length,
              edgeCount: graph.edges.length,
            }, null, 2),
          },
        ],
      };
    }
  );
}