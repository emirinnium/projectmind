import { Command } from 'commander';
import { withContext, asyncHandler, output } from '../utils/shared.js';

export function createMemoryCommand(): Command {
  return new Command('memory')
    .description('Read or write agent memory')
    .argument('[scope]', 'Memory scope (e.g., module name, file path)')
    .argument('[key]', 'Memory key')
    .option('-s, --set <value>', 'Set a memory value')
    .option('-S, --session <id>', 'Session ID')
    .action(asyncHandler(async (scope: string, key: string, opts: { set?: string; session?: string }) => {
      await withContext(async (ctx) => {
        if (!scope) {
          output.info('Usage: projectmind memory <scope> [key] [-s "value"] [-S session-id]');
          return;
        }

        if (opts.set) {
          const sessionId = opts.session ? Number(opts.session) : 0;
          if (sessionId) {
            ctx.kg.storeMemory(sessionId, scope, key || 'default', JSON.stringify(opts.set));
            output.success(`Stored memory: ${scope}/${key || 'default'}`);
          } else {
            output.warn('Session ID required for memory operations. Use --session <id>');
          }
        } else {
          const memories = ctx.kg.getMemory(scope, key || undefined);
          if (memories.length === 0) {
            output.info(`No memory found for scope: ${scope}${key ? ` / key: ${key}` : ''}`);
          } else {
            for (const m of memories) {
              output.kv(`[${m.scope}/${m.key}]`, JSON.stringify(m.value));
              output.kv('  (session:', `${m.sessionId}, created: ${m.createdAt})`);
            }
          }
        }
      });
    }));
}