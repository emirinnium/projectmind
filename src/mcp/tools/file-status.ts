import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { confineToProject } from './_shared.js';
import type { McpDependencies } from './types.js';
import { fileWatches, stopLiveWatch } from './file-watch-state.js';

export function registerGetFileStatusTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'get_file_status',
    {
      title: 'Get File Status',
      description:
        'Get real-time status of a file including coherence, dependencies, and agent activity.',
      inputSchema: {
        filePath: z.string().describe('Path of the file'),
      },
    },
    async (args) => {
      const absolutePath = confineToProject(args.filePath, deps.projectRoot);
      const file = deps.kg.getFileByPath(args.filePath);
      if (!file) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'File not found in knowledge graph. Run scan_project first.',
              }),
            },
          ],
        };
      }

      const imports = deps.kg.getImportsWithDetails(file.id);
      const dependents = deps.kg.getDependents(file.id);
      const functions = deps.kg.getFunctions(file.id);
      const classes = deps.kg.getClasses(file.id);

      // Check for recent coherence decisions
      const coherenceDecisions = deps.kg.getCoherenceDecisions
        ? deps.kg.getCoherenceDecisions(file.id)
        : [];

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                file: {
                  path: file.relativePath,
                  hash: file.hash,
                  language: file.language,
                  sizeBytes: file.sizeBytes,
                  cognitiveLoad: file.cognitiveLoad,
                  agentTouched: file.agentTouched,
                  agentTouchedBy: file.agentTouchedBy,
                  agentTouchedAt: file.agentTouchedAt,
                  lastScanned: file.lastScanned,
                },
                imports: {
                  total: imports.length,
                  resolved: imports.filter((i) => i.resolvedFile).length,
                  unresolved: imports.filter((i) => !i.resolvedFile).map((i) => i.source),
                  details: imports.map((i) => ({
                    source: i.source,
                    kind: i.kind,
                    resolved: !!i.resolvedFile,
                    resolvedPath: i.resolvedFile?.relativePath,
                  })),
                },
                dependents: {
                  count: dependents.length,
                  files: dependents.map((d) => ({
                    path: d.relativePath,
                    cognitiveLoad: d.cognitiveLoad,
                    agentTouched: d.agentTouched,
                  })),
                },
                structure: {
                  functions: functions.map((f) => ({
                    name: f.name,
                    complexity: f.complexity,
                    lines: (f.endLine ?? 0) - (f.startLine ?? 0),
                  })),
                  classes: classes.map((c) => ({
                    name: c.name,
                    methods: c.methodsCount,
                    properties: c.propertiesCount,
                  })),
                },
                coherence: {
                  decisions: coherenceDecisions.length,
                  lastDecision: coherenceDecisions[0] || null,
                },
                watches:
                  fileWatches
                    .get(absolutePath)
                    ?.filter((watchEntry) => watchEntry.agentId.length > 0).length || 0,
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

export function registerUnregisterFileWatchTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'unregister_file_watch',
    {
      title: 'Unregister File Watch',
      description: 'Stop watching a file for continuous synchronization.',
      inputSchema: {
        filePath: z.string().describe('Path of the file to stop watching'),
        agentId: z.string().trim().min(1).max(200).describe('Agent ID that registered the watch'),
      },
    },
    async (args) => {
      const absolutePath = confineToProject(args.filePath, deps.projectRoot);
      const watches = fileWatches.get(absolutePath) ?? [];
      const removed = watches.some((w) => w.agentId === args.agentId);
      if (removed) stopLiveWatch(absolutePath, args.agentId);
      const filtered = watches.filter((w) => w.agentId !== args.agentId);

      if (filtered.length === 0) {
        fileWatches.delete(absolutePath);
      } else {
        fileWatches.set(absolutePath, filtered);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: removed,
                status: removed ? 'unregistered' : 'not_watching',
                filePath: args.filePath,
                agentId: args.agentId,
                remainingWatches: filtered.length,
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
