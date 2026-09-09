import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { confineToProject } from './_shared.js';
import type { McpDependencies } from './types.js';
import { fileWatches, startLiveWatch } from './file-watch-state.js';

export function registerFileWatchTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'register_file_watch',
    {
      title: 'Register File Watch',
      description:
        'Watch a file for changes during this server session: change events flag the file as agent-touched. Registry is session-scoped (not persisted across restarts).',
      inputSchema: {
        filePath: z.string().describe('Path of the file to watch'),
        agentId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe('Unique identifier for the coding agent'),
        events: z
          .array(z.literal('change'))
          .default(['change'])
          .describe('Events to watch for (currently only file changes are supported)'),
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

      const watches = fileWatches.get(absolutePath) || [];
      const existing = watches.find((w) => w.agentId === args.agentId);

      if (existing) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'already_watching',
                  file: file.relativePath,
                  agentId: args.agentId,
                  events: args.events,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      watches.push({
        agentId: args.agentId,
        registeredAt: new Date().toISOString(),
      });
      fileWatches.set(absolutePath, watches);
      startLiveWatch(deps, absolutePath, args.agentId);

      // Return current file state for sync
      const imports = deps.kg.getImportsWithDetails(file.id);
      const functions = deps.kg.getFunctions(file.id);
      const classes = deps.kg.getClasses(file.id);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'watching',
                file: {
                  path: file.relativePath,
                  hash: file.hash,
                  cognitiveLoad: file.cognitiveLoad,
                  agentTouched: file.agentTouched,
                  agentTouchedBy: file.agentTouchedBy,
                  lastScanned: file.lastScanned,
                },
                context: {
                  imports: imports.map((i) => ({
                    source: i.source,
                    kind: i.kind,
                    resolved: !!i.resolvedFile,
                  })),
                  functions: functions.map((f) => ({ name: f.name, complexity: f.complexity })),
                  classes: classes.map((c) => ({ name: c.name, methods: c.methodsCount })),
                },
                events: args.events,
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
