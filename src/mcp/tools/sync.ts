import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';

// In-memory store for file watches (in production, use persistent storage)
const fileWatches = new Map<string, { agentId: string; callback?: string; registeredAt: string }[]>();

export function registerFileWatchTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'register_file_watch',
    {
      title: 'Register File Watch',
      description: 'Register interest in a file for continuous synchronization between coding agent and ProjectMind.',
      inputSchema: {
        filePath: z.string().describe('Path of the file to watch'),
        agentId: z.string().describe('Unique identifier for the coding agent'),
        events: z.array(z.enum(['change', 'analyze', 'coherence', 'imports'])).default(['change']).describe('Events to watch for'),
      },
    },
    async (args) => {
      const file = deps.kg.getFileByPath(args.filePath);
      if (!file) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'File not found in knowledge graph. Run scan_project first.' }) }],
        };
      }

      const watches = fileWatches.get(args.filePath) || [];
      const existing = watches.find((w) => w.agentId === args.agentId);
      
      if (existing) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'already_watching',
                file: file.relativePath,
                agentId: args.agentId,
                events: args.events,
              }, null, 2),
            },
          ],
        };
      }

      watches.push({
        agentId: args.agentId,
        registeredAt: new Date().toISOString(),
      });
      fileWatches.set(args.filePath, watches);

      // Return current file state for sync
      const imports = deps.kg.getImportsWithDetails(file.id);
      const functions = deps.kg.getFunctions(file.id);
      const classes = deps.kg.getClasses(file.id);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
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
                imports: imports.map((i) => ({ source: i.source, kind: i.kind, resolved: !!i.resolvedFile })),
                functions: functions.map(f => ({ name: f.name, complexity: f.complexity })),
                classes: classes.map(c => ({ name: c.name, methods: c.methodsCount })),
              },
              events: args.events,
            }, null, 2),
          },
        ],
      };
    }
  );
}

export function registerGetFileStatusTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'get_file_status',
    {
      title: 'Get File Status',
      description: 'Get real-time status of a file including coherence, dependencies, and agent activity.',
      inputSchema: {
        filePath: z.string().describe('Path of the file'),
      },
    },
    async (args) => {
      const file = deps.kg.getFileByPath(args.filePath);
      if (!file) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'File not found in knowledge graph. Run scan_project first.' }) }],
        };
      }

      const imports = deps.kg.getImportsWithDetails(file.id);
      const dependents = deps.kg.getDependents(file.id);
      const functions = deps.kg.getFunctions(file.id);
      const classes = deps.kg.getClasses(file.id);

      // Check for recent coherence decisions
      const coherenceDecisions = deps.kg.getCoherenceDecisions ? deps.kg.getCoherenceDecisions(file.id) : [];

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
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
                functions: functions.map(f => ({
                  name: f.name,
                  complexity: f.complexity,
                  lines: (f.endLine ?? 0) - (f.startLine ?? 0),
                })),
                classes: classes.map(c => ({
                  name: c.name,
                  methods: c.methodsCount,
                  properties: c.propertiesCount,
                })),
              },
              coherence: {
                decisions: coherenceDecisions.length,
                lastDecision: coherenceDecisions[0] || null,
              },
              watches: fileWatches.get(file.relativePath)?.length || 0,
            }, null, 2),
          },
        ],
      };
    }
  );
}

export function registerSyncContextTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'sync_context',
    {
      title: 'Sync Context',
      description: 'Synchronize context between coding agent and ProjectMind - share current working state, decisions, and patterns.',
      inputSchema: {
        agentId: z.string().describe('Unique identifier for the coding agent'),
        action: z.enum(['push', 'pull', 'both']).default('both').describe('Direction of sync'),
        context: z.object({
          currentFile: z.string().optional().describe('Currently editing file'),
          recentDecisions: z.array(z.object({
            file: z.string(),
            decision: z.string(),
            reasoning: z.string(),
            timestamp: z.string(),
          })).optional().describe('Recent architectural decisions'),
          patternsUsed: z.array(z.string()).optional().describe('Patterns being applied'),
          issuesFound: z.array(z.object({
            file: z.string(),
            issue: z.string(),
            severity: z.enum(['high', 'medium', 'low']),
          })).optional().describe('Issues discovered during coding'),
        }).optional().describe('Context to push from coding agent'),
      },
    },
    async (args) => {
      try {
        // Reuse existing session for this agent instead of creating new one
        const sessions = deps.kg.getAgentSessions(args.agentId);
        const session = sessions[0];
        const sessionId = session ? session.id : deps.kg.startAgentSession(args.agentId);
        
        let pushed = false;
        let pulled: { decisions: Array<{ key: string; value: unknown }>; patterns: Array<{ key: string; value: unknown }>; issues: Array<{ key: string; value: unknown }>; sync: Array<{ key: string; value: unknown }> } | null = null;

        if (args.action === 'push' || args.action === 'both') {
          if (args.context) {
            // Store context in agent memory
            if (args.context.currentFile) {
              deps.kg.storeMemory(sessionId, 'sync', 'current_file', args.context.currentFile);
            }
            if (args.context.recentDecisions) {
              for (const decision of args.context.recentDecisions) {
                deps.kg.storeMemory(sessionId, 'decisions', decision.file, JSON.stringify(decision));
              }
            }
            if (args.context.patternsUsed) {
              deps.kg.storeMemory(sessionId, 'patterns', 'used', JSON.stringify(args.context.patternsUsed));
            }
            if (args.context.issuesFound) {
              for (const issue of args.context.issuesFound) {
                deps.kg.storeMemory(sessionId, 'issues', issue.file, JSON.stringify(issue));
              }
            }
            pushed = true;
          }
        }

        if (args.action === 'pull' || args.action === 'both') {
          // Pull relevant context from ProjectMind
          const decisions = deps.kg.getMemory('decisions');
          const patterns = deps.kg.getMemory('patterns');
          const issues = deps.kg.getMemory('issues');
          const syncData = deps.kg.getMemory('sync');

          pulled = {
            decisions: decisions.map((d) => ({ key: d.key, value: d.value })),
            patterns: patterns.map((p) => ({ key: p.key, value: p.value })),
            issues: issues.map((i) => ({ key: i.key, value: i.value })),
            sync: syncData.map((s) => ({ key: s.key, value: s.value })),
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                sessionId,
                agentId: args.agentId,
                action: args.action,
                pushed,
                pulled,
                message: 'Context synchronized successfully',
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Sync failed' }) }],
        };
      }
    }
  );
}

export function registerUnregisterFileWatchTool(server: McpServer, _deps: McpDependencies): void {
  server.registerTool(
    'unregister_file_watch',
    {
      title: 'Unregister File Watch',
      description: 'Stop watching a file for continuous synchronization.',
      inputSchema: {
        filePath: z.string().describe('Path of the file to stop watching'),
        agentId: z.string().describe('Agent ID that registered the watch'),
      },
    },
    async (args) => {
      const watches = fileWatches.get(args.filePath) || [];
      const filtered = watches.filter((w) => w.agentId !== args.agentId);
      
      if (filtered.length === 0) {
        fileWatches.delete(args.filePath);
      } else {
        fileWatches.set(args.filePath, filtered);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'unregistered',
              filePath: args.filePath,
              agentId: args.agentId,
              remainingWatches: filtered.length,
            }, null, 2),
          },
        ],
      };
    }
  );
}