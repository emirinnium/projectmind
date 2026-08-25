import { z } from 'zod';
import { watch, type FSWatcher } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { parseFile } from '../../parser/ast-parser.js';
import { loadConfig } from '../../utils/config.js';

// Session-scoped registry of live watchers + intent records.
// Watchers perform REAL change detection: on any file event the file is
// flagged as agent-touched so subsequent scans/status reflect the activity.
const fileWatches = new Map<string, { agentId: string; callback?: string; registeredAt: string }[]>();
const liveWatchers = new Map<string, FSWatcher>();

function startLiveWatch(deps: McpDependencies, filePath: string, agentId: string): void {
  const key = `${filePath}::${agentId}`;
  if (liveWatchers.has(key)) return;
  try {
    const w = watch(filePath, { persistent: false }, () => {
      try {
        deps.kg.markAgentTouched(filePath, agentId);
      } catch {
        // Never let a watcher crash the server.
      }
      // Incremental single-file refresh: re-parse and upsert so functions,
      // classes and dependents in the KG stay current without a full
      // scan_project. Best-effort; embedding is intentionally NOT regenerated
      // here (provider may be unavailable) — next full scan refreshes it.
      try {
        const struct = parseFile(filePath);
        if (struct) {
          const root = loadConfig().projectRoot.replace(/\\/g, '/');
          const norm = filePath.replace(/\\/g, '/');
          const rel = norm.startsWith(root) ? norm.slice(root.length + 1) : norm;
          void Promise.resolve(deps.kg.upsertFile(struct, rel)).catch(() => {});
        }
      } catch {
        // Refresh is opportunistic — never crash the watcher.
      }
    });
    w.on('error', () => liveWatchers.delete(key));
    liveWatchers.set(key, w);
  } catch {
    // File may not exist yet / permission: registration intent still recorded.
  }
}

function stopLiveWatch(filePath: string, agentId: string): void {
  const key = `${filePath}::${agentId}`;
  liveWatchers.get(key)?.close();
  liveWatchers.delete(key);
}

export function closeAllLiveWatchers(): void {
  for (const [, w] of liveWatchers) w.close();
  liveWatchers.clear();
}

export function registerFileWatchTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'register_file_watch',
    {
      title: 'Register File Watch',
      description: 'Watch a file for changes during this server session: change events flag the file as agent-touched. Registry is session-scoped (not persisted across restarts).',
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
      startLiveWatch(deps, args.filePath, args.agentId);

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

        // Living Context Window enrichment result (filled inside the pull
        // branch below when the agent reports its current file).
        let enrichment: { file?: string; dependents?: string[]; similar?: string[] } | undefined;

        if (args.action === 'pull' || args.action === 'both') {
          // Pull relevant context from ProjectMind. Entries are ranked by
          // relevance to the current file (key/path term overlap) with
          // recency as tiebreaker, then capped so the model's context is not
          // flooded by unranked key-value dumps.
          const currentFile = args.context?.currentFile ?? '';
          const fileTerms = currentFile.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);

          const rank = (entries: Array<{ key: string; value: unknown; createdAt?: string }>): Array<{ key: string; value: unknown }> =>
            entries
              .map((e) => {
                const hay = `${e.key}`.toLowerCase();
                const relevance = fileTerms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
                return { e, relevance, ts: e.createdAt ? Date.parse(e.createdAt) || 0 : 0 };
              })
              .sort((a, b) => (b.relevance - a.relevance) || (b.ts - a.ts))
              .slice(0, 10)
              .map(({ e }) => ({ key: e.key, value: e.value }));

          pulled = {
            decisions: rank(deps.kg.getMemory('decisions')),
            patterns: rank(deps.kg.getMemory('patterns')),
            issues: rank(deps.kg.getMemory('issues')),
            sync: rank(deps.kg.getMemory('sync')),
          };

          // Living Context Window enrichment: attach the reported file's real
          // dependency closure + similar files to every pull.
          const ctxFile = typeof currentFile === 'string' ? currentFile : '';
          if (ctxFile.length > 0) {
            try {
              const f = deps.kg.getFileByPath(ctxFile);
              if (f) {
                const dependents = deps.kg.getDependents(f.id).map((d) => d.relativePath).slice(0, 10);
                let similar: string[] = [];
                const emb = deps.kg.getFileEmbedding ? deps.kg.getFileEmbedding(f.id) : null;
                if (emb) {
                  similar = deps.kg.findSimilarFiles(emb, 0.7, 5).map((s) => s.relativePath);
                }
                enrichment = { file: f.relativePath, dependents, similar };
              }
            } catch {
              // Enrichment is best-effort — never break the sync.
            }
          }
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
                enrichment,
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
      stopLiveWatch(args.filePath, args.agentId);
      const watches = fileWatches.get(args.filePath) ?? [];
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