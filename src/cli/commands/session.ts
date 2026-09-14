import { Command } from 'commander';
import { withContext, asyncHandler, output } from '@/cli/utils/shared.js';
import {
  getSessionInsights,
  recordSessionEvent,
  SESSION_EVENT_TYPES,
  type SessionEventType,
} from '@/core/intelligence/session-learner.js';

export function createSessionCommands(): Command {
  const sessionCmd = new Command('session').description('Manage agent sessions');

  sessionCmd.action(() => {
    sessionCmd.outputHelp();
  });

  sessionCmd
    .command('start')
    .description('Start an agent session')
    .argument('[name]', 'Agent name', 'ai-agent')
    .option('-j, --json', 'Output machine-readable JSON')
    .action(
      asyncHandler(async (name: string, opts: { json?: boolean }) => {
        await withContext(async (ctx) => {
          const sessionId = ctx.kg.startAgentSession(name);
          if (opts.json) {
            output.json({
              protocolVersion: 1,
              action: 'start',
              sessionId,
              agentName: name,
            });
          } else {
            output.success(`Session started: ${name} (ID: ${sessionId})`);
            output.info(
              `Use session ID for memory operations: projectmind memory <scope> <key> -s "value" -S ${sessionId}`,
            );
          }
        });
      }),
    );

  sessionCmd
    .command('end')
    .description('End an agent session')
    .argument('<id>', 'Session ID')
    .option('-j, --json', 'Output machine-readable JSON')
    .action(
      asyncHandler(async (id: string, opts: { json?: boolean }) => {
        await withContext(async (ctx) => {
          const sessionId = Number(id);
          if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
            throw new Error(`Session ID must be a positive integer: ${id}`);
          }
          if (!ctx.kg.endAgentSession(sessionId)) {
            if (opts.json) {
              output.json({
                protocolVersion: 1,
                action: 'end',
                sessionId,
                ended: false,
                error: 'Session was not found or was already ended.',
              });
            } else {
              output.warn(`Session ${id} was not found or was already ended.`);
            }
            return;
          }
          if (opts.json) {
            output.json({ protocolVersion: 1, action: 'end', sessionId, ended: true });
          } else {
            output.success(`Session ${id} ended.`);
          }
        });
      }),
    );

  sessionCmd
    .command('event')
    .description('Record a bounded event for cross-session insights')
    .argument('<id>', 'Session ID')
    .argument('<type>', 'file_touched|tool_used|pattern|outcome')
    .argument('<key>', 'Project-relative path or bounded identifier')
    .argument('[value]', 'Optional bounded value')
    .option('--success', 'Mark an outcome as successful')
    .option('--failure', 'Mark an outcome as failed')
    .option('-j, --json', 'Output machine-readable JSON')
    .action(
      asyncHandler(
        async (
          id: string,
          type: string,
          key: string,
          value: string | undefined,
          opts: { success?: boolean; failure?: boolean; json?: boolean },
        ) => {
          await withContext(async (ctx) => {
            const sessionId = Number(id);
            if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
              throw new Error(`Session ID must be a positive integer: ${id}`);
            }
            if (!(SESSION_EVENT_TYPES as readonly string[]).includes(type)) {
              throw new Error(
                `Event type must be one of ${SESSION_EVENT_TYPES.join(', ')}: ${type}`,
              );
            }
            if (opts.success && opts.failure) {
              throw new Error('Use either --success or --failure, not both.');
            }
            const session = ctx.kg
              .getAgentSessions(undefined, 1000)
              .find((candidate) => candidate.id === sessionId);
            if (!session) throw new Error(`Session ${sessionId} was not found.`);
            const receipt = recordSessionEvent(ctx.db, ctx.kg.getCurrentProjectId(), {
              sessionId,
              agentName: session.agentName,
              eventType: type as SessionEventType,
              eventKey: key,
              eventValue: value,
              ...(opts.success || opts.failure ? { success: Boolean(opts.success) } : {}),
            });
            if (opts.json) {
              output.json({ protocolVersion: 1, action: 'event', receipt });
            } else {
              output.success(
                `Recorded session event ${receipt.id}: ${receipt.eventType}/${receipt.eventKey}`,
              );
            }
          });
        },
      ),
    );

  sessionCmd
    .command('insights')
    .description('Show evidence-backed cross-session insights')
    .option('--agent <name>', 'Filter by agent')
    .option('--limit <n>', 'Rows per insight group', '10')
    .option('--max-events <n>', 'Maximum events to scan', '10000')
    .option('-j, --json', 'Output machine-readable JSON')
    .action(
      asyncHandler(
        async (opts: { agent?: string; limit: string; maxEvents: string; json?: boolean }) => {
          await withContext(async (ctx) => {
            const limit = Number(opts.limit);
            const maxEvents = Number(opts.maxEvents);
            const insights = getSessionInsights(ctx.db, ctx.kg.getCurrentProjectId(), {
              agentName: opts.agent,
              limit,
              maxEvents,
            });
            if (opts.json) {
              output.json({ protocolVersion: 1, insights });
              return;
            }
            output.section('Cross-session insights');
            output.kv('Events / sessions', `${insights.eventsScanned} / ${insights.sessions}`);
            if (insights.files.length > 0) {
              output.section('Frequently touched files');
              for (const file of insights.files) {
                output.kv(file.path, `${file.events} event(s), ${file.sessions} session(s)`);
              }
            }
            if (insights.tools.length > 0) {
              output.section('Tool usage');
              for (const tool of insights.tools) {
                output.kv(tool.tool, `${tool.uses} use(s), ${tool.sessions} session(s)`);
              }
            }
            for (const suggestion of insights.suggestions) output.info(suggestion);
            for (const limitation of insights.limitations) output.info(`Limit: ${limitation}`);
          });
        },
      ),
    );

  return sessionCmd;
}
