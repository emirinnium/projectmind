import { Command } from 'commander';
import { statSync } from 'node:fs';
import { BaseCommand, asyncHandler, output } from '@/cli/utils/shared.js';
import { ContextBudgetOptimizer, createFullFilePlan } from '@/core/context/budget-optimizer.js';
import { calculateContextRoi, compareContextPlans } from '@/core/context/roi.js';
import type { ContextItem } from '@/core/context/types.js';
import { classifyTask } from '@/core/search/intent-engine.js';
import type { TaskType } from '@/core/search/types.js';
import { isTestPath } from '@/utils/test-detection.js';
import { assertProjectPath } from '@/core/security/path-security.js';
import { createContextTokenCounter, countContextFileTokens } from '@/core/context/tokenizer.js';

interface ContextBudgetOptions {
  root?: string;
  budget: string;
  files?: string[];
  strategy: string;
  limit: string;
  format: string;
  task?: string;
  inputPricePer1k?: string;
  tokenizer: string;
  tokenizerModel?: string;
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
      .alias('budget')
      .option('-r, --root <path>', 'Project directory; defaults to configured project root')
      .option('--budget <tokens>', 'Token budget to respect', '8000')
      .option(
        '--files <paths...>',
        'Candidate files (defaults to the files in the knowledge graph)',
      )
      .option('--strategy <strategy>', 'Selection strategy: greedy|dp|adaptive', 'dp')
      .option('--limit <n>', 'Maximum candidate files to consider', '50')
      .option('--format <fmt>', 'Output format: text|json', 'text')
      .option('--task <task>', 'Task description (alias for the positional task)')
      .option(
        '--input-price-per-1k <usd>',
        'Optional provider input price in USD per 1,000 estimated tokens',
      )
      .option(
        '--tokenizer <mode>',
        'Token counting mode: heuristic|transformers (transformers is optional and may download a model)',
        'heuristic',
      )
      .option('--tokenizer-model <model>', 'Transformers tokenizer model identifier')
      .action(
        asyncHandler(async (task: string | undefined, opts: ContextBudgetOptions) => {
          await this.withContext(async (ctx) => {
            const budget = parseInt(opts.budget, 10);
            if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 10_000_000) {
              throw new Error(
                `Invalid --budget value: "${opts.budget}" (expected a positive integer)`,
              );
            }
            const limit = parseInt(opts.limit, 10);
            if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100_000) {
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
            if (!['text', 'json'].includes(opts.format)) {
              throw new Error(`Invalid --format value: "${opts.format}" (expected text|json)`);
            }
            if (opts.tokenizer !== 'heuristic' && opts.tokenizer !== 'transformers') {
              throw new Error(
                `Invalid --tokenizer value: "${opts.tokenizer}" (expected heuristic|transformers)`,
              );
            }
            const tokenCounter = await createContextTokenCounter({
              mode: opts.tokenizer as 'heuristic' | 'transformers',
              model: opts.tokenizerModel,
            });

            // F31: the optional task description selects the task-type used
            // for relevance boosts BEFORE selection.
            const effectiveTask = opts.task ?? task;
            const taskType: TaskType | undefined = effectiveTask
              ? classifyTask(effectiveTask)
              : undefined;

            // Candidate items: explicit --files win; otherwise the knowledge
            // graph provides the candidates. Token counts are auto-estimated
            // from file size and relevance defaults to 0.5 (neutral), exactly
            // like the MCP plan_context_budget tool.
            let items: ContextItem[];
            if (opts.files && opts.files.length > 0) {
              items = [];
              for (const path of opts.files.slice(0, limit)) {
                const absolutePath = assertProjectPath(path, ctx.config.projectRoot, {
                  mustExist: true,
                  rejectIgnored: true,
                });
                items.push({
                  path,
                  tokens:
                    opts.tokenizer === 'heuristic'
                      ? ContextBudgetOptimizer.tokenEstimator(absolutePath)
                      : await countContextFileTokens(absolutePath, tokenCounter),
                  bytes: statSync(absolutePath).size,
                  relevanceScore: 0.5,
                  isTestFile: isTestPath(path),
                });
              }
            } else {
              const files = ctx.kg.getAllFiles().slice(0, limit);
              if (files.length === 0) {
                output.warn('No files found in knowledge graph.');
                output.info('Run "projectmind scan" first.');
                return;
              }
              items = [];
              for (const file of files) {
                items.push({
                  path: file.relativePath,
                  tokens:
                    opts.tokenizer === 'heuristic'
                      ? ContextBudgetOptimizer.tokenEstimator(file.path)
                      : await countContextFileTokens(file.path, tokenCounter),
                  bytes: file.sizeBytes,
                  relevanceScore: 0.5,
                  isTestFile: isTestPath(file.relativePath),
                });
              }
            }

            const optimizer = new ContextBudgetOptimizer({ strategy, taskType });
            const plan = optimizer.optimize(items, budget, taskType);
            const inputPricePer1k =
              opts.inputPricePer1k === undefined ? undefined : Number(opts.inputPricePer1k);
            if (
              inputPricePer1k !== undefined &&
              (!Number.isFinite(inputPricePer1k) || inputPricePer1k < 0 || inputPricePer1k > 1000)
            ) {
              throw new Error('--input-price-per-1k must be a number between 0 and 1000.');
            }
            const roiOptions = {
              inputPricePer1k: inputPricePer1k ?? ctx.config.llm.pricing?.inputPricePer1k,
              pricing: ctx.config.llm.pricing,
              tokenMeasurement: tokenCounter.mode,
              tokenizerModel: tokenCounter.model ?? undefined,
            } as const;
            const roi = calculateContextRoi(items, plan, roiOptions);
            const fullFilePlan = createFullFilePlan(items);
            const planComparisons = compareContextPlans(
              items,
              [
                { variant: 'full-file', plan: fullFilePlan },
                { variant: 'budgeted-file', plan },
                {
                  variant: 'byte-range',
                  limitations: [
                    'No source ranges were supplied to this command; use get_source_range or get_source_symbol_range to produce a bounded range first.',
                  ],
                },
                {
                  variant: 'canonical-example',
                  limitations: [
                    'Canonical-example selection is not part of this budget invocation.',
                  ],
                },
                {
                  variant: 'graph-closure',
                  limitations: ['Graph closure was not requested by this budget invocation.'],
                },
              ],
              roiOptions,
            );

            if (opts.format === 'json') {
              output.json({
                task: task ?? null,
                taskDescription: effectiveTask ?? null,
                taskType: taskType ?? null,
                strategy,
                totalTokens: plan.totalTokens,
                allocatedTokens: plan.allocatedTokens,
                compressionStrategy: plan.compressionStrategy,
                files: plan.files,
                excludedFiles: plan.excludedFiles,
                roi,
                planComparisons,
              });
              return;
            }

            output.section('Context Budget Plan');
            output.kv('Budget', `${plan.totalTokens} tokens`);
            output.kv('Allocated', `${plan.allocatedTokens} tokens`);
            output.kv('Strategy', strategy);
            if (effectiveTask) output.kv('Task', effectiveTask);
            if (taskType) output.kv('Task type', taskType);
            if (plan.compressionStrategy) output.kv('Compression', plan.compressionStrategy);
            output.kv(
              'Estimated saved tokens',
              `${roi.estimatedSavedTokens} (${roi.estimatedSavedPercent}%)`,
            );
            if (roi.estimatedSavedCostUsd !== null) {
              output.kv('Estimated saved input cost', `$${roi.estimatedSavedCostUsd.toFixed(6)}`);
            } else {
              output.info('Input price not supplied; dollar savings are unavailable.');
            }
            output.kv('Relevance coverage', `${(roi.relevanceCoverage * 100).toFixed(1)}%`);
            output.kv(
              'Plan comparison',
              `${planComparisons.filter((entry) => entry.available).length}/${planComparisons.length} variants measured`,
            );
            output.info(
              roi.status === 'measured'
                ? `ROI status: measured by ${roi.tokenizerModel}; provider billing savings are not claimed.`
                : 'ROI status: estimated; provider billing savings are not claimed.',
            );

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
          }, opts.root);
        }),
      );

    return cmd;
  }
}

export function createContextBudgetCommand(): Command {
  return new ContextBudgetCommand().registerCommands();
}
