import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import type { McpDependencies } from './types.js';

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
        let enrichmentError: string | undefined;

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
            } catch (error) {
              // Enrichment is best-effort — never break the sync, but expose
              // the failure so callers can distinguish partial context from
              // a fully enriched synchronization result.
              logger.warn('Context enrichment failed during synchronization:', {
                file: ctxFile,
                error: error instanceof Error ? error.message : String(error),
              });
              enrichmentError = error instanceof Error ? error.message : String(error);
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
                  enrichment: {
                    status: enrichment
                      ? 'complete'
                      : enrichmentError
                        ? 'failed'
                        : args.context?.currentFile
                          ? 'not-found'
                          : 'not-requested',
                    ...enrichment,
                  },
                  ...(enrichmentError ? { enrichmentError } : {}),
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
