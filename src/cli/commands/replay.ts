import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { Command } from 'commander';
import { withContext, asyncHandler, output } from '@/cli/utils/shared.js';
import {
  AgentReplayStore,
  compareReplayEvent,
  summarizeReplayTimeline,
} from '@/core/replay/agent-replay.js';
import { reconstructContext } from '@/core/replay/context-reconstruction.js';
import { computeIndexedGraphHash } from '@/core/ledger/evidence-ledger.js';
import { confineToProject } from '@/mcp/tools/_shared.js';
import type { ReplayEventType } from '@/core/replay/agent-replay.js';

interface ReplayOptions {
  session?: string;
  limit: string;
  verify?: boolean;
  reconstructContext?: boolean;
  format: string;
}

function sourceHash(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseOutcome(raw: string): Record<string, string | number | boolean | null> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--outcome must be a JSON object with scalar values.');
  }
  const outcome: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean' &&
      value !== null
    ) {
      throw new Error(`--outcome.${key} must be a string, number, boolean, or null.`);
    }
    outcome[key] = value;
  }
  return outcome;
}

/** `projectmind replay [file]` — inspect recorded agent decisions and drift. */
export function createReplayCommand(): Command {
  const command = new Command('replay')
    .description('Inspect recorded agent context and decision metadata')
    .argument('[file]', 'Optional project-relative file to filter')
    .option('--session <id>', 'Filter by agent session ID')
    .option('--limit <n>', 'Maximum events to display', '100')
    .option('--verify', 'Verify replay event hashes before listing')
    .option('--reconstruct-context', 'Re-read files from recorded context snapshots')
    .option('--format <format>', 'Output format: text|json', 'text');

  command.action(
    asyncHandler(async (file: string | undefined, opts: ReplayOptions) => {
      if (!['text', 'json'].includes(opts.format)) {
        throw new Error(`Invalid --format value: "${opts.format}" (expected text|json)`);
      }
      const limit = Number.parseInt(opts.limit, 10);
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
        throw new Error(`Invalid --limit value: "${opts.limit}" (expected 1..1000)`);
      }
      const sessionId = opts.session === undefined ? undefined : Number.parseInt(opts.session, 10);
      if (sessionId !== undefined && (!Number.isSafeInteger(sessionId) || sessionId <= 0)) {
        throw new Error(`Invalid --session value: "${opts.session}" (expected a positive integer)`);
      }

      await withContext(async (ctx) => {
        const replay = new AgentReplayStore(ctx.db, ctx.kg.getCurrentProjectId());
        const relativeFile = file
          ? relative(
              ctx.config.projectRoot,
              confineToProject(file, ctx.config.projectRoot),
            ).replace(/\\/g, '/')
          : undefined;
        const verification = opts.verify ? replay.verify() : undefined;
        const events = replay.list({ filePath: relativeFile, sessionId, limit });
        const currentSourceHash = relativeFile
          ? sourceHash(confineToProject(relativeFile, ctx.config.projectRoot))
          : undefined;
        const current = {
          ...(relativeFile
            ? {
                sourceHash: currentSourceHash,
              }
            : {}),
          ...(events.some((event) => event.graphHash)
            ? { graphHash: computeIndexedGraphHash(ctx.kg) }
            : {}),
        };
        const comparisons = events.map((event) => compareReplayEvent(event, current));
        const timeline = summarizeReplayTimeline(comparisons);
        const contextReplay = opts.reconstructContext
          ? events
              .filter((event) => event.eventType === 'context')
              .map((event) => ({
                eventId: event.id,
                ...reconstructContext(ctx.config.projectRoot, event, true),
              }))
          : undefined;
        const payload = {
          file: relativeFile ?? null,
          sessionId: sessionId ?? null,
          events: comparisons,
          timeline,
          ...(verification ? { verification } : {}),
          ...(contextReplay ? { contextReplay } : {}),
        };
        if (opts.format === 'json') {
          output.json(payload);
          return;
        }

        output.section('Agent Replay');
        output.kv('File', relativeFile ?? 'all recorded events');
        output.kv('Events', String(comparisons.length));
        output.kv(
          'Timeline',
          `${timeline.firstEventAt ?? 'n/a'} → ${timeline.lastEventAt ?? 'n/a'}`,
        );
        if (timeline.durationMs !== null) output.kv('Duration', `${timeline.durationMs} ms`);
        if (contextReplay) {
          output.kv('Context reconstructions', String(contextReplay.length));
          for (const replay of contextReplay) {
            output.kv(`  Context #${replay.eventId}`, replay.status);
            if (replay.reason) output.info(`    ${replay.reason}`);
          }
        }
        if (verification) output.kv('Chain verification', verification.valid ? 'valid' : 'invalid');
        for (const event of comparisons) {
          output.kv(
            `#${event.id} ${event.eventType} ${event.toolName}`,
            `${event.status}${event.filePath ? ` — ${event.filePath}` : ''}`,
          );
          if (event.reason) output.info(`  ${event.reason}`);
        }
        if (comparisons.length === 0) {
          output.info('No recorded replay events matched this filter.');
        }
      });
    }),
  );

  command
    .command('record <file>')
    .description('Record payload-free replay metadata for a file')
    .option('--session <id>', 'Optional agent session ID')
    .option('--event-type <type>', 'scan|context|review|edit|decision', 'decision')
    .option('--tool <name>', 'Tool or command name', 'manual')
    .option('--outcome <json>', 'Bounded scalar outcome JSON object', '{}')
    .action(
      asyncHandler(
        async (
          file: string,
          opts: { session?: string; eventType: string; tool: string; outcome: string },
        ) => {
          const eventTypes: ReplayEventType[] = ['scan', 'context', 'review', 'edit', 'decision'];
          if (!eventTypes.includes(opts.eventType as ReplayEventType)) {
            throw new Error(`Invalid --event-type value: "${opts.eventType}"`);
          }
          const sessionId =
            opts.session === undefined ? undefined : Number.parseInt(opts.session, 10);
          if (sessionId !== undefined && (!Number.isSafeInteger(sessionId) || sessionId <= 0)) {
            throw new Error(
              `Invalid --session value: "${opts.session}" (expected a positive integer)`,
            );
          }
          const outcome = parseOutcome(opts.outcome);
          await withContext(async (ctx) => {
            const absolutePath = confineToProject(file, ctx.config.projectRoot);
            const relativeFile = relative(ctx.config.projectRoot, absolutePath).replace(/\\/g, '/');
            const currentSourceHash = sourceHash(absolutePath);
            const event = new AgentReplayStore(ctx.db, ctx.kg.getCurrentProjectId()).append({
              ...(sessionId === undefined ? {} : { sessionId }),
              eventType: opts.eventType as ReplayEventType,
              toolName: opts.tool,
              filePath: relativeFile,
              ...(currentSourceHash ? { sourceHash: currentSourceHash } : {}),
              graphHash: computeIndexedGraphHash(ctx.kg),
              outcome,
            });
            output.success(`Replay event recorded: #${event.id} ${event.eventHash}`);
          });
        },
      ),
    );

  return command;
}
