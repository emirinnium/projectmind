import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { AutoFixFeedbackStore, sourceHashForContent } from '@/core/refactor/autofix-feedback.js';
import { AUTO_FIXER_IDS } from '@/mcp/tools/auto-fix.js';
import { asyncHandler, output, withContext } from '@/cli/utils/shared.js';
import type { AutoFixFeedbackValue } from '@/core/refactor/autofix-feedback.js';
import { confineToProject } from '@/mcp/tools/_shared.js';

interface FeedbackOptions {
  feedback: string;
  agent?: string;
  format: string;
}

interface RecommendOptions {
  fixers?: string;
  agent?: string;
  minimumSamples: string;
  decayDays?: string;
  format: string;
}

function validateFormat(format: string): asserts format is 'text' | 'json' {
  if (format !== 'text' && format !== 'json') {
    throw new Error(`--format must be text or json: ${format}`);
  }
}

function parseFeedback(value: string): AutoFixFeedbackValue {
  if (value !== 'accepted' && value !== 'rejected' && value !== 'skipped') {
    throw new Error(`--feedback must be accepted, rejected, or skipped: ${value}`);
  }
  return value;
}

function parseFixers(value: string | undefined): string[] {
  const fixers = value
    ? value
        .split(',')
        .map((fixer) => fixer.trim())
        .filter(Boolean)
    : [...AUTO_FIXER_IDS];
  const unknown = fixers.filter((fixer) => !(AUTO_FIXER_IDS as readonly string[]).includes(fixer));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown auto-fixer(s): ${unknown.join(', ')}. Available: ${AUTO_FIXER_IDS.join(', ')}`,
    );
  }
  return [...new Set(fixers)];
}

function parseMinimumSamples(value: string): number {
  const samples = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100) {
    throw new Error(`--minimum-samples must be an integer between 1 and 100: ${value}`);
  }
  return samples;
}

function parseDecayDays(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0 || days > 3650) {
    throw new Error(`--decay-days must be a positive number up to 3650: ${value}`);
  }
  return days;
}

function createStore(ctx: {
  db: import('node:sqlite').DatabaseSync;
  kg: { getCurrentProjectId(): number };
}): AutoFixFeedbackStore {
  return new AutoFixFeedbackStore(ctx.db, ctx.kg.getCurrentProjectId());
}

/** Feedback-aware auto-fix recommendations and append-only outcome recording. */
export function createAutofixCommand(): Command {
  const command = new Command('autofix')
    .description('Inspect and personalize AST-safe auto-fix recommendations')
    .action(() => command.outputHelp());

  command
    .command('record <fixer>')
    .description('Record an accepted, rejected, or skipped auto-fix outcome')
    .requiredOption('--feedback <value>', 'accepted|rejected|skipped')
    .option('--agent <name>', 'Agent profile name')
    .option('--file <path>', 'Optional source file; only its SHA-256 hash is stored')
    .option('--format <format>', 'Output: text|json', 'text')
    .action(
      asyncHandler(async (fixer: string, options: FeedbackOptions & { file?: string }) => {
        if (!(AUTO_FIXER_IDS as readonly string[]).includes(fixer)) {
          throw new Error(`Unknown auto-fixer: ${fixer}. Available: ${AUTO_FIXER_IDS.join(', ')}`);
        }
        const feedback = parseFeedback(options.feedback);
        validateFormat(options.format);
        await withContext(async (ctx) => {
          const sourceHash = options.file
            ? sourceHashForContent(
                readFileSync(confineToProject(options.file, ctx.config.projectRoot), 'utf8'),
              )
            : undefined;
          const record = createStore(ctx).record({
            fixer,
            feedback,
            agentName: options.agent,
            sourceHash,
          });
          if (options.format === 'json') {
            output.json({ success: true, record });
            return;
          }
          output.section('Auto-Fix Feedback');
          output.kv('Fixer', record.fixer);
          output.kv('Feedback', record.feedback);
          output.kv('Stored source hash', record.sourceHash ? 'yes' : 'no');
          output.success('Feedback recorded as append-only metadata.');
        });
      }),
    );

  command
    .command('recommend')
    .description('Recommend fixers from repo-scoped accept/reject history')
    .option('--fixers <ids>', 'Comma-separated fixer ids; defaults to all fixers')
    .option('--agent <name>', 'Agent profile name')
    .option('--minimum-samples <n>', 'Decided examples required before a recommendation', '3')
    .option('--decay-days <days>', 'Optional half-life for older feedback')
    .option('--format <format>', 'Output: text|json', 'text')
    .action(
      asyncHandler(async (options: RecommendOptions) => {
        validateFormat(options.format);
        const fixers = parseFixers(options.fixers);
        const minimumSamples = parseMinimumSamples(options.minimumSamples);
        await withContext(async (ctx) => {
          const recommendations = createStore(ctx).recommend(fixers, {
            agentName: options.agent,
            minimumSamples,
            decayDays: parseDecayDays(options.decayDays),
          });
          if (options.format === 'json') {
            output.json({ success: true, recommendations });
            return;
          }
          output.section('Auto-Fix Recommendations');
          for (const recommendation of recommendations) {
            const rate =
              recommendation.acceptanceRate === null
                ? 'n/a'
                : `${(recommendation.acceptanceRate * 100).toFixed(1)}%`;
            output.kv(
              recommendation.fixer,
              `${recommendation.status} — ${rate} acceptance — ${recommendation.reason}`,
            );
          }
          output.info(
            'Recommendations are evidence-gated; mixed or small samples remain inconclusive.',
          );
        });
      }),
    );

  for (const [name, optedOut, description] of [
    ['opt-out', true, 'Disable auto-fix feedback collection for an agent scope'],
    ['opt-in', false, 'Enable auto-fix feedback collection for an agent scope'],
  ] as const) {
    command
      .command(name)
      .description(description)
      .option('--agent <name>', 'Agent profile name')
      .option('--format <format>', 'Output: text|json', 'text')
      .action(
        asyncHandler(async (options: { agent?: string; format: string }) => {
          validateFormat(options.format);
          await withContext(async (ctx) => {
            const store = createStore(ctx);
            store.setOptOut(options.agent, optedOut);
            const payload = { success: true, agentName: options.agent ?? null, optedOut };
            if (options.format === 'json') {
              output.json(payload);
              return;
            }
            output.section('Auto-Fix Feedback Preference');
            output.kv('Agent', options.agent ?? 'default');
            output.kv('Status', optedOut ? 'opted out' : 'opted in');
            output.success(
              optedOut ? 'Feedback collection disabled.' : 'Feedback collection enabled.',
            );
          });
        }),
      );
  }

  command
    .command('reset')
    .description('Logically reset personalization while retaining the audit history')
    .option('--agent <name>', 'Agent profile name')
    .option('--format <format>', 'Output: text|json', 'text')
    .action(
      asyncHandler(async (options: { agent?: string; format: string }) => {
        validateFormat(options.format);
        await withContext(async (ctx) => {
          const reset = createStore(ctx).reset(options.agent);
          if (options.format === 'json') {
            output.json({ success: true, reset });
            return;
          }
          output.section('Auto-Fix Feedback Reset');
          output.kv('Agent', options.agent ?? 'default');
          output.kv('Reset id', String(reset.resetId));
          output.success('Personalization reset; historical records were retained.');
        });
      }),
    );

  return command;
}
