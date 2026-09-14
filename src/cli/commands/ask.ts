import { Command } from 'commander';
import { withContext, asyncHandler, output } from '@/cli/utils/shared.js';
import { answerCodebaseQuestion } from '@/core/intelligence/qa-engine.js';
import { createLLMProvider } from '@/core/llm/index.js';

interface AskOptions {
  limit: string;
  maxFiles: string;
  llm?: boolean;
  format: string;
}

/** Evidence-first natural-language codebase Q&A command. */
export function createAskCommand(): Command {
  return new Command('ask')
    .description('Answer a codebase question from source-backed evidence')
    .argument('<question>', 'Natural-language question about the codebase')
    .option('--limit <n>', 'Maximum evidence files', '5')
    .option('--max-files <n>', 'Maximum indexed files to inspect', '200')
    .option('--llm', 'Use the configured LLM to synthesize wording from evidence')
    .option('--format <format>', 'Output: text|json|markdown', 'text')
    .action(
      asyncHandler(async (question: string, opts: AskOptions) => {
        if (!['text', 'json', 'markdown'].includes(opts.format)) {
          throw new Error(`--format must be text, json, or markdown: ${opts.format}`);
        }
        const limit = Number(opts.limit);
        const maxFiles = Number(opts.maxFiles);
        await withContext(async (ctx) => {
          const llm = opts.llm
            ? createLLMProvider({
                provider: ctx.config.llm.provider,
                model: ctx.config.llm.model,
                apiKey: ctx.config.llm.apiKey,
                apiUrl: ctx.config.llm.endpoint,
                deepModel: ctx.config.llm.deepModel,
                reasoning: ctx.config.llm.reasoning,
              })
            : null;
          const result = await answerCodebaseQuestion(ctx.kg, ctx.config.projectRoot, question, {
            limit,
            maxFilesToInspect: maxFiles,
            useLlm: Boolean(opts.llm),
            llmProvider: llm,
          });
          if (opts.format === 'json') {
            output.json(result);
            return;
          }
          if (opts.format === 'markdown') {
            output.raw(renderMarkdown(result));
            return;
          }
          output.section('ProjectMind answer');
          output.kv('Question type', result.questionType);
          output.kv('Confidence', `${(result.confidence * 100).toFixed(1)}% (heuristic)`);
          output.kv('Synthesis', result.synthesis);
          output.raw(result.answer);
          output.section('Evidence');
          for (const item of result.evidence) {
            output.kv(
              `${item.filePath}:${item.lineStart}-${item.lineEnd}`,
              `relevance=${(item.relevance * 100).toFixed(1)}%, freshness=${item.freshness}`,
            );
          }
          for (const limitation of result.limitations) output.info(`Limit: ${limitation}`);
          if (result.refusal) output.warn(result.refusal);
        });
      }),
    );
}

function renderMarkdown(result: Awaited<ReturnType<typeof answerCodebaseQuestion>>): string {
  const lines = [
    '# ProjectMind answer',
    '',
    `- Question type: ${result.questionType}`,
    `- Confidence: ${(result.confidence * 100).toFixed(1)}% (heuristic)`,
    `- Synthesis: ${result.synthesis}`,
    '',
    result.answer,
    '',
    '## Evidence',
    '',
  ];
  for (const item of result.evidence) {
    lines.push(
      `- \`${item.filePath}:${item.lineStart}-${item.lineEnd}\` — relevance ${(item.relevance * 100).toFixed(1)}%, freshness ${item.freshness}`,
    );
  }
  lines.push('', '## Limitations', '');
  for (const limitation of result.limitations) lines.push(`- ${limitation}`);
  return lines.join('\n');
}
