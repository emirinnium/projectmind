import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { confineToProject } from './_shared.js';
import {
  AgentReplayStore,
  compareReplayEvent,
  summarizeReplayTimeline,
} from '@/core/replay/agent-replay.js';
import { computeIndexedGraphHash } from '@/core/ledger/evidence-ledger.js';
import { reconstructContext } from '@/core/replay/context-reconstruction.js';
import { asUntrustedContent } from '@/mcp/security/untrusted-content.js';

const replayOutcomeSchema = z.record(
  z.string(),
  z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]),
);

export function registerReplayTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'agent_replay',
    {
      title: 'Agent Replay',
      description:
        'Inspect recorded agent context/decision metadata and compare source/graph hashes with the current project. Returns recorded, diverged, or unavailable; it never re-runs an edit and never changes files.',
      inputSchema: {
        filePath: z.string().trim().min(1).max(1000).optional().describe('Optional file filter'),
        sessionId: z.number().int().positive().optional().describe('Optional session filter'),
        limit: z.number().int().min(1).max(1000).default(100).describe('Maximum events'),
        verify: z.boolean().default(false).describe('Verify stored event hashes'),
        reconstructContext: z
          .boolean()
          .default(false)
          .describe('Re-read hash-matching files from recorded context snapshots'),
      },
    },
    async (args) => {
      try {
        if (!deps.db)
          throw new Error('Replay storage is unavailable because the database is not configured.');
        const replay = new AgentReplayStore(deps.db, deps.kg.getCurrentProjectId());
        const relativeFile = args.filePath
          ? relative(deps.projectRoot, confineToProject(args.filePath, deps.projectRoot)).replace(
              /\\/g,
              '/',
            )
          : undefined;
        const verification = args.verify ? replay.verify() : undefined;
        const events = replay.list({
          filePath: relativeFile,
          sessionId: args.sessionId,
          limit: args.limit,
        });
        const contextReplay = args.reconstructContext
          ? events
              .filter((event) => event.eventType === 'context')
              .map((event) => {
                const reconstruction = reconstructContext(deps.projectRoot, event, true);
                return {
                  eventId: event.id,
                  status: reconstruction.status,
                  reason: reconstruction.reason,
                  files: reconstruction.files.map((file) => ({
                    ...file,
                    ...(file.content === undefined
                      ? {}
                      : {
                          content: asUntrustedContent(file.content, 'source', {
                            relativePath: file.path,
                          }),
                        }),
                  })),
                };
              })
          : undefined;
        const current = {
          ...(relativeFile
            ? {
                sourceHash: (() => {
                  const path = confineToProject(relativeFile, deps.projectRoot);
                  return existsSync(path)
                    ? createHash('sha256').update(readFileSync(path)).digest('hex')
                    : undefined;
                })(),
              }
            : {}),
          ...(events.some((event) => event.graphHash)
            ? { graphHash: computeIndexedGraphHash(deps.kg) }
            : {}),
        };
        const comparisons = events.map((event) => compareReplayEvent(event, current));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  filePath: relativeFile ?? null,
                  sessionId: args.sessionId ?? null,
                  events: comparisons,
                  timeline: summarizeReplayTimeline(comparisons),
                  ...(verification ? { verification } : {}),
                  ...(contextReplay ? { contextReplay } : {}),
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
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'record_replay_event',
    {
      title: 'Record Replay Event',
      description:
        'Record payload-free context/decision metadata for a later agent replay. Source content is never stored; when filePath is supplied its current hash is captured automatically.',
      inputSchema: {
        sessionId: z.number().int().positive().optional().describe('Optional agent session ID'),
        eventType: z
          .enum(['scan', 'context', 'review', 'edit', 'decision'])
          .describe('Kind of event being recorded'),
        toolName: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe('Tool or command that produced the event'),
        filePath: z.string().trim().min(1).max(1000).optional().describe('Optional project file'),
        outcome: replayOutcomeSchema
          .optional()
          .default({})
          .describe('Bounded structural outcome summary; do not send source or secrets'),
      },
    },
    async (args) => {
      try {
        if (!deps.db)
          throw new Error('Replay storage is unavailable because the database is not configured.');
        let filePath: string | undefined;
        let sourceHash: string | undefined;
        if (args.filePath) {
          const absolutePath = confineToProject(args.filePath, deps.projectRoot);
          filePath = relative(deps.projectRoot, absolutePath).replace(/\\/g, '/');
          if (existsSync(absolutePath)) {
            sourceHash = createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
          }
        }
        const store = new AgentReplayStore(deps.db, deps.kg.getCurrentProjectId());
        const event = store.append({
          ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
          eventType: args.eventType,
          toolName: args.toolName,
          ...(filePath ? { filePath, ...(sourceHash ? { sourceHash } : {}) } : {}),
          graphHash: computeIndexedGraphHash(deps.kg),
          outcome: args.outcome,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, event }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    },
  );
}
