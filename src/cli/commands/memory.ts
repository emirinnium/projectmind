import { Command } from 'commander';
import { withContext, asyncHandler, output } from '@/cli/utils/shared.js';
import { searchTeamMemoriesSemantic } from '@/core/memory/semantic-memory.js';

export function createMemoryCommand(): Command {
  const memoryCmd = new Command('memory')
    .description('Read or write agent memory')
    .argument('[scope]', 'Memory scope (e.g., module name, file path)')
    .argument('[key]', 'Memory key')
    .option('-s, --set <value>', 'Set a memory value')
    .option('-S, --session <id>', 'Session ID')
    .action(asyncHandler(async (scope: string, key: string, opts: { set?: string; session?: string }) => {
      await withContext(async (ctx) => {
        if (!scope) {
          output.info('Usage: projectmind memory <scope> [key] [-s "value"] [-S session-id]');
          output.info('       projectmind memory search "<natural language query>" [--limit N] [--agent name]');
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

  memoryCmd
    .command('search <query>')
    .description('Semantic search over team memories (RAG-style, works offline)')
    .option('--limit <n>', 'Max hits', '5')
    .option('--threshold <n>', 'Cosine floor (lower = broader)', '0.05')
    .option('--agent <name>', 'Filter by author agent after ranking')
    .action(asyncHandler(async (query: string, opts: { limit?: string; threshold?: string; agent?: string }) => {
      await withContext(async (ctx) => {
        const result = await searchTeamMemoriesSemantic(
          () => ctx.kg.getAllTeamMemories(opts.agent || 'unknown'),
          {
            query,
            limit: Math.max(1, parseInt(opts.limit ?? '5', 10) || 5),
            threshold: parseFloat(opts.threshold ?? '0.05') || 0.05,
            ...(opts.agent ? { agentName: opts.agent } : {}),
          }
        );
        output.section(`Semantic Memory Search`);
        output.kv('Query', result.query);
        output.kv('Scanned / returned', `${result.scanned} / ${result.returned}`);
        if (result.hits.length === 0) {
          output.info('No memories above threshold.');
          return;
        }
        for (const hit of result.hits) {
          output.kv(`${hit.score.toFixed(3)} [${hit.scope}/${hit.key}] by ${hit.agentName}`, hit.preview);
        }
      });
    }));

  return memoryCmd;
}