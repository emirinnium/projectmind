import { Command } from 'commander';
import { withContext, asyncHandler, output } from '../utils/shared.js';

export function createSessionCommands(): Command {
  const sessionCmd = new Command('session')
    .description('Manage agent sessions');

  sessionCmd
    .command('start')
    .description('Start an agent session')
    .argument('[name]', 'Agent name', 'ai-agent')
    .action(asyncHandler(async (name: string) => {
      await withContext(async (ctx) => {
        const sessionId = ctx.kg.startAgentSession(name);
        output.success(`Session started: ${name} (ID: ${sessionId})`);
        output.info(`Use session ID for memory operations: projectmind memory <scope> <key> -s "value" -S ${sessionId}`);
      });
    }));

  sessionCmd
    .command('end')
    .description('End an agent session')
    .argument('<id>', 'Session ID')
    .action(asyncHandler(async (id: string) => {
      await withContext(async (ctx) => {
        ctx.kg.endAgentSession(Number(id));
        output.success(`Session ${id} ended.`);
      });
    }));

  return sessionCmd;
}