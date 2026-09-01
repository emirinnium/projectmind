import { Command } from 'commander';
import { resolve } from 'node:path';
import { BaseCommand, asyncHandler, output } from '@/cli/utils/shared.js';
import { ContextBudgetOptimizer } from '@/core/context/budget-optimizer.js';
import type { ContextItem } from '@/core/context/types.js';
import { classifyTask } from '@/core/search/intent-engine.js';
import type { TaskType } from '@/core/search/types.js';
import { isTestPath } from '@/utils/test-detection.js';

interface ContextBudgetOptions {
  budget: string;
  files?: string[];
  strategy: string;
  limit: string;
  format: string;
}

/**
 * `projectmind context-budget [<task>]` — plan which files to load into a
 * limited context/token budget. CLI counterpart of the MCP
 * `plan_context_budget` tool: same engine (ContextBudgetOptimizer, value-based
 * DP knapsack with greedy fallback), same defaults (auto token estimation,
 * neutral 0.5 relevance), plus optional task-type boosts derived from a
 * natural-language task description via classifyTask.
 */
class ContextBudgetCommand extends BaseCommand {
  constructor() {
    super('context-budget', 'Optimize context window usage');
  }

  registerCommands(): Command {
    const cmd = this.cmd;

    cmd
      .argument(
        '[task]',
        'Task description used to boost relevant files (e.g. "fix the login bug")',
      )
      .option('--budget <tokens>', 'Token budget to respect', '8000')
      .option(
        '--files <paths...>',
        'Candidate files (defaults to the files in the knowledge graph)',
      )
      .option('--strategy <strategy>', 'Selection strategy: greedy|dp|adaptive', 'dp')
      .option('--limit <n>', 'Maximum candidate files to consider', '50')
      .option('--format <fmt>', 'Output format: text|json', 'text')
      .action(
        asyncHandler(async (task: string | undefined, opts: ContextBudgetOptions) => {
          await this.withContext(async (ctx) => {
            const budget = parseInt(opts.budget, 10);
            if (!Number.isFinite(budget) || budget <= 0) {
              throw new Error(
                `Invalid --budget value: "${opts.budget}" (expected a positive integer)`,
              );
            }
            const limit = parseInt(opts.limit, 10);
            if (!Number.isFinite(limit) || limit <= 0) {
              throw new Error(
                `Invalid --limit value: "${opts.limit}" (expected a positive integer)`,
              );
            }
            if (
              opts.strategy !== 'greedy' &&
              opts.strategy !== 'dp' &&
              opts.strategy !== 'adaptive'
            ) {
              throw new Error(
                `Invalid --strategy value: "${opts.strategy}" (expected greedy|dp|adaptive)`,
              );
            }
            const strategy = opts.strategy;

            // F31: the optional task description selects the task-type used
            // for relevance boosts BEFORE selection.
            const taskType: TaskType | undefined = task ? classifyTask(task) : undefined;

            // Candidate items: explicit --files win; otherwise the knowledge
            // graph provides the candidates. Token counts are auto-estimated
            // from file size and relevance defaults to 0.5 (neutral), exactly
            // like the MCP plan_context_budget tool.
            let items: ContextItem[];
            if (opts.files && opts.files.length > 0) {
              items = opts.files.slice(0, limit).map((path) => ({
                path,
                tokens: ContextBudgetOptimizer.tokenEstimator(
                  resolve(ctx.config.projectRoot, path),
                ),
                relevanceScore: 0.5,
                isTestFile: isTestPath(path),
              }));
            } else {
              const files = ctx.kg.getAllFiles().slice(0, limit);
              if (files.length === 0) {
                output.warn('No files found in knowledge graph.');
                output.info('Run "projectmind scan" first.');
                return;
              }
              items = files.map((file) => ({
                path: file.relativePath,
                tokens: ContextBudgetOptimizer.tokenEstimator(file.path),
                relevanceScore: 0.5,
                isTestFile: isTestPath(file.relativePath),
              }));
            }

            const optimizer = new ContextBudgetOptimizer({ strategy, taskType });
            const plan = optimizer.optimize(items, budget, taskType);

            if (opts.format === 'json') {
              console.log(
                JSON.stringify(
                  {
                    task: task ?? null,
                    taskType: taskType ?? null,
                    strategy,
                    totalTokens: plan.totalTokens,
                    allocatedTokens: plan.allocatedTokens,
                    compressionStrategy: plan.compressionStrategy,
                    files: plan.files,
                    excludedFiles: plan.excludedFiles,
                  },
                  null,
                  2,
                ),
              );
              return;
            }

            output.section('Context Budget Plan');
            output.kv('Budget', `${plan.totalTokens} tokens`);
            output.kv('Allocated', `${plan.allocatedTokens} tokens`);
            output.kv('Strategy', strategy);
            if (task) output.kv('Task', task);
            if (taskType) output.kv('Task type', taskType);
            if (plan.compressionStrategy) output.kv('Compression', plan.compressionStrategy);

            output.section(`Included files (${plan.files.length})`);
            for (const file of plan.files) {
              output.kv(file.path, `${file.tokens} tokens — ${file.inclusionReason}`);
            }

            if (plan.excludedFiles.length > 0) {
              output.section(`Excluded files (${plan.excludedFiles.length})`);
              for (const file of plan.excludedFiles.slice(0, 10)) {
                output.kv(file.path, file.reason);
              }
              if (plan.excludedFiles.length > 10) {
                output.info(`  ... and ${plan.excludedFiles.length - 10} more`);
              }
            }
          });
        }),
      );

    return cmd;
  }
}

export function createContextBudgetCommand(): Command {
  return new ContextBudgetCommand().registerCommands();
}
