import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { watch, type FSWatcher } from 'node:fs';
import { z } from 'zod';

import { logger } from '../../utils/logger.js';

import { parseFile } from '../../parser/ast-parser.js';

import { loadConfig } from '../../utils/config.js';

import type { McpDependencies } from './types.js';

// Session-scoped registry of live watchers + intent records.
// Watchers perform REAL change detection: on any file event the file is
// flagged as agent-touched so subsequent scans/status reflect the activity.
const fileWatches = new Map<
  string,
  { agentId: string; callback?: string; registeredAt: string }[]
>();
const liveWatchers = new Map<string, FSWatcher>();
// Intentional stops must NOT reschedule: without this set the 'close'/'error'
// handlers resurrect every watcher ~5s after unregister_file_watch.
const intentionalStops = new Set<string>();
const pendingRestarts = new Map<string, NodeJS.Timeout>();

function scheduleRestart(key: string, startWatcher: () => void): void {
  if (intentionalStops.has(key)) return;
  if (pendingRestarts.has(key)) return;
  pendingRestarts.set(
    key,
    setTimeout(() => {
      pendingRestarts.delete(key);
      startWatcher();
    }, 5000),
  );
}

export function startLiveWatch(deps: McpDependencies, filePath: string, agentId: string): void {
  const key = `${filePath}::${agentId}`;
  if (liveWatchers.has(key)) return;
  intentionalStops.delete(key);

  const startWatcher = () => {
    try {
      const w = watch(filePath, { persistent: false }, (eventType) => {
        if (eventType !== 'change') return;
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
            void Promise.resolve(deps.kg.upsertFile(struct, rel))
              .then((fileId) => deps.kg.storeFileDetails(fileId, struct))
              .catch((error) => {
                logger.warn(`Watcher KG upsert failed for ${rel}:`, {
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          }
        } catch {
          // Refresh is opportunistic — never crash the watcher.
        }
      });

      w.on('error', (error) => {
        logger.warn(`Watcher error for ${filePath}:`, {
          error: error instanceof Error ? error.message : String(error),
        });
        liveWatchers.delete(key);
        scheduleRestart(key, startWatcher);
      });

      w.on('close', () => {
        liveWatchers.delete(key);
        if (intentionalStops.has(key)) {
          intentionalStops.delete(key);
          return;
        }
        scheduleRestart(key, startWatcher);
      });

      liveWatchers.set(key, w);
      logger.info(`Started watching ${filePath} for agent ${agentId}`);
    } catch (error) {
      logger.warn(`Failed to start watcher for ${filePath}:`, {
        error: error instanceof Error ? error.message : String(error),
      });
      scheduleRestart(key, startWatcher);
    }
  };

  startWatcher();
}

export function stopLiveWatch(filePath: string, agentId: string): void {
  const key = `${filePath}::${agentId}`;
  intentionalStops.add(key);
  const pending = pendingRestarts.get(key);
  if (pending) {
    clearTimeout(pending);
    pendingRestarts.delete(key);
  }
  liveWatchers.get(key)?.close();
  liveWatchers.delete(key);
}

export function closeAllLiveWatchers(): void {
  for (const [key, w] of liveWatchers) {
    intentionalStops.add(key);
    w.close();
  }
  for (const [, t] of pendingRestarts) clearTimeout(t);
  pendingRestarts.clear();
  liveWatchers.clear();
}

export function liveWatcherStats(): { active: number; pendingRestarts: number } {
  return { active: liveWatchers.size, pendingRestarts: pendingRestarts.size };
}

export function hasLiveWatch(filePath: string, agentId: string): boolean {
  return liveWatchers.has(`${filePath}::${agentId}`);
}

export function registerFileWatchTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'register_file_watch',
    {
      title: 'Register File Watch',
      description:
        'Watch a file for changes during this server session: change events flag the file as agent-touched. Registry is session-scoped (not persisted across restarts).',
      inputSchema: {
        filePath: z.string().describe('Path of the file to watch'),
        agentId: z.string().describe('Unique identifier for the coding agent'),
        events: z
          .array(z.enum(['change', 'analyze', 'coherence', 'imports']))
          .default(['change'])
          .describe('Events to watch for'),
      },
    },
    async (args) => {
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

      const watches = fileWatches.get(args.filePath) || [];
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
                watches: fileWatches.get(file.relativePath)?.length || 0,
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

export function registerSyncContextTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'sync_context',
    {
      title: 'Sync Context',
      description:
        'Synchronize context between coding agent and ProjectMind - share current working state, decisions, and patterns. Supports diff merge and conflict resolution.',
      inputSchema: {
        agentId: z.string().describe('Unique identifier for the coding agent'),
        action: z.enum(['push', 'pull', 'both']).default('both').describe('Direction of sync'),
        context: z
          .object({
            currentFile: z.string().optional().describe('Currently editing file'),
            recentDecisions: z
              .array(
                z.object({
                  file: z.string(),
                  decision: z.string(),
                  reasoning: z.string(),
                  timestamp: z.string(),
                  version: z.number().optional().describe('Version for conflict resolution'),
                }),
              )
              .optional()
              .describe('Recent architectural decisions'),
            patternsUsed: z.array(z.string()).optional().describe('Patterns being applied'),
            issuesFound: z
              .array(
                z.object({
                  file: z.string(),
                  issue: z.string(),
                  severity: z.enum(['high', 'medium', 'low']),
                  version: z.number().optional().describe('Version for conflict resolution'),
                }),
              )
              .optional()
              .describe('Issues discovered during coding'),
            workingState: z
              .record(z.string(), z.unknown())
              .optional()
              .describe('Agent working state (key-value pairs)'),
          })
          .optional()
          .describe('Context to push from coding agent'),
      },
    },
    async (args) => {
      try {
        // Reuse existing session for this agent instead of creating new one
        const sessions = deps.kg.getAgentSessions(args.agentId);
        const session = sessions[0];
        const sessionId = session ? session.id : deps.kg.startAgentSession(args.agentId);

        let pushed = false;
        let pulled: {
          decisions: Array<{ key: string; value: unknown; version: number }>;
          patterns: Array<{ key: string; value: unknown; version: number }>;
          issues: Array<{ key: string; value: unknown; version: number }>;
          sync: Array<{ key: string; value: unknown; version: number }>;
          conflicts?: Array<{
            key: string;
            local: unknown;
            remote: unknown;
            base?: unknown;
            resolution?: 'local' | 'remote' | 'manual';
          }>;
        } | null = null;

        if (args.action === 'push' || args.action === 'both') {
          if (args.context) {
            // Store context in agent memory with versioning for conflict resolution
            if (args.context.currentFile) {
              deps.kg.storeMemory(sessionId, 'sync', 'current_file', args.context.currentFile);
            }
            if (args.context.recentDecisions) {
              for (const decision of args.context.recentDecisions) {
                const key = `decision:${decision.file}`;
                const existingEntries = deps.kg.getMemory('decisions', key);
                const existing = existingEntries[0]?.value;
                const version =
                  existing && typeof existing === 'object' && 'version' in existing
                    ? ((existing as { version: number }).version || 0) + 1
                    : 1;
                deps.kg.storeMemory(
                  sessionId,
                  'decisions',
                  key,
                  JSON.stringify({ ...decision, version }),
                );
              }
            }
            if (args.context.patternsUsed) {
              const existingEntries = deps.kg.getMemory('patterns', 'used');
              const existing = existingEntries[0]?.value;
              const version =
                existing && typeof existing === 'object' && 'version' in existing
                  ? ((existing as { version: number }).version || 0) + 1
                  : 1;
              deps.kg.storeMemory(
                sessionId,
                'patterns',
                'used',
                JSON.stringify({ patterns: args.context.patternsUsed, version }),
              );
            }
            if (args.context.issuesFound) {
              for (const issue of args.context.issuesFound) {
                const key = `issue:${issue.file}`;
                const existingEntries = deps.kg.getMemory('issues', key);
                const existing = existingEntries[0]?.value;
                const version =
                  existing && typeof existing === 'object' && 'version' in existing
                    ? ((existing as { version: number }).version || 0) + 1
                    : 1;
                deps.kg.storeMemory(
                  sessionId,
                  'issues',
                  key,
                  JSON.stringify({ ...issue, version }),
                );
              }
            }
            if (args.context.workingState) {
              for (const [key, value] of Object.entries(args.context.workingState)) {
                deps.kg.storeMemory(sessionId, 'sync', key, JSON.stringify(value));
              }
            }
            pushed = true;
          }
        }

        // Living Context Window enrichment result
        let enrichment: { file?: string; dependents?: string[]; similar?: string[] } | undefined;

        // Conflict detection: compare local and remote versions
        let conflicts: Array<{
          key: string;
          local: unknown;
          remote: unknown;
          base?: unknown;
          resolution?: 'local' | 'remote' | 'manual';
        }> = [];

        if (args.action === 'pull' || args.action === 'both') {
          // Pull relevant context from ProjectMind with versioning
          const currentFile = args.context?.currentFile ?? '';
          const fileTerms = currentFile
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((t) => t.length > 3);

          const rank = (
            entries: Array<{ key: string; value: unknown; createdAt?: string; version?: number }>,
          ): Array<{ key: string; value: unknown; version: number }> =>
            entries
              .map((e) => {
                const hay = `${e.key}`.toLowerCase();
                const relevance = fileTerms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
                return { e, relevance, ts: e.createdAt ? Date.parse(e.createdAt) || 0 : 0 };
              })
              .sort((a, b) => b.relevance - a.relevance || b.ts - a.ts)
              .slice(0, 10)
              .map(({ e }) => ({
                key: e.key,
                value: e.value,
                version: e.version || 0,
              }));

          const decisions = rank(deps.kg.getMemory('decisions'));
          const patterns = rank(deps.kg.getMemory('patterns'));
          const issues = rank(deps.kg.getMemory('issues'));
          const sync = rank(deps.kg.getMemory('sync'));

          if (args.context?.recentDecisions) {
            for (const localDecision of args.context.recentDecisions) {
              const key = `decision:${localDecision.file}`;
              const remoteDecision = decisions.find((d) => d.key === key);
              if (remoteDecision && remoteDecision.version > (localDecision.version || 0)) {
                conflicts.push({
                  key,
                  local: localDecision,
                  remote: remoteDecision.value,
                });
              }
            }
          }

          if (args.context?.issuesFound) {
            for (const localIssue of args.context.issuesFound) {
              const key = `issue:${localIssue.file}`;
              const remoteIssue = issues.find((i) => i.key === key);
              if (remoteIssue && remoteIssue.version > (localIssue.version || 0)) {
                conflicts.push({
                  key,
                  local: localIssue,
                  remote: remoteIssue.value,
                });
              }
            }
          }

          pulled = {
            decisions,
            patterns,
            issues,
            sync,
            ...(conflicts.length > 0 ? { conflicts } : {}),
          };

          // Living Context Window enrichment
          const ctxFile = typeof currentFile === 'string' ? currentFile : '';
          if (ctxFile.length > 0) {
            try {
              const f = deps.kg.getFileByPath(ctxFile);
              if (f) {
                const dependents = deps.kg
                  .getDependents(f.id)
                  .map((d) => d.relativePath)
                  .slice(0, 10);
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
              text: JSON.stringify(
                {
                  sessionId,
                  agentId: args.agentId,
                  action: args.action,
                  pushed,
                  pulled,
                  enrichment,
                  message: conflicts?.length
                    ? `Context synchronized with ${conflicts.length} conflicts detected.`
                    : 'Context synchronized successfully',
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: error instanceof Error ? error.message : 'Sync failed',
              }),
            },
          ],
        };
      }
    },
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
            text: JSON.stringify(
              {
                status: 'unregistered',
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
