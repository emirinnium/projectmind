import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { assertProjectPath } from '@/core/security/path-security.js';
import { HistoryRanker } from '@/core/search/history-ranking.js';
import { lexicalRelevance } from '@/core/search/hybrid-ranking.js';
import { selectCanonicalExample, sourceHash } from '@/core/search/canonical-example.js';
import { logger } from '@/utils/logger.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export function createCanonicalExampleCommand(): Command {
  return new Command('canonical-example')
    .description('Select a source-backed stable JS/TS example for a query')
    .argument('<query>', 'Behavior or concept to find an example for')
    .option('-n, --limit <n>', 'Maximum candidates to report', '20')
    .option('--format <format>', 'Output format: text|json', 'text')
    .action(
      asyncHandler(async (query: string, opts: { limit: string; format: string }) => {
        if (!['text', 'json'].includes(opts.format))
          throw new Error('--format must be text or json.');
        const limit = Number.parseInt(opts.limit, 10);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
          throw new Error('--limit must be an integer between 1 and 50.');
        await withService(['scale'], async (ctx) => {
          const history = new HistoryRanker(ctx.config.projectRoot);
          const skippedFiles: string[] = [];
          const files = ctx.kg
            .getAllFiles()
            .filter((file) => SOURCE_EXTENSIONS.has(extname(file.relativePath).toLowerCase()))
            .slice(0, 500);
          const historyScores = history.scoreMany(files.map((file) => file.relativePath));
          const candidates = files.flatMap((file) => {
            try {
              const path = assertProjectPath(file.relativePath, ctx.config.projectRoot, {
                mustExist: true,
                rejectIgnored: true,
              });
              const content = readFileSync(path, 'utf8');
              const connections =
                (ctx.kg.getImports(file.id)?.length ?? 0) +
                (ctx.kg.getDependents(file.id)?.length ?? 0);
              return [
                {
                  path: file.relativePath,
                  sourceHash: sourceHash(content),
                  relevanceScore: lexicalRelevance(query, file.relativePath, content),
                  historyScore: historyScores.get(file.relativePath.replace(/\\/g, '/')),
                  graphScore: Math.min(1, 0.2 + connections * 0.05),
                  ownershipScore: file.agentTouched ? 0.65 : 0.5,
                  testScore: /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(file.relativePath) ? 0.9 : 0.5,
                  coherenceScore: Math.max(0.2, 1 - Math.min(1, file.cognitiveLoad / 10)),
                  freshnessScore: 0.5,
                },
              ];
            } catch (error) {
              skippedFiles.push(file.relativePath);
              logger.debug('Canonical example skipped an unreadable source file.', {
                filePath: file.relativePath,
                error: error instanceof Error ? error.message : String(error),
              });
              return [];
            }
          });
          const selection = selectCanonicalExample(candidates);
          selection.candidates = selection.candidates.slice(0, limit);
          const limitations =
            skippedFiles.length > 0
              ? [
                  `${skippedFiles.length} indexed source file(s) were skipped because they could not be read or did not pass path policy.`,
                ]
              : [];
          const report = { ...selection, skippedFiles: skippedFiles.slice(0, 50), limitations };
          if (opts.format === 'json') output.json(report);
          else if (selection.selected) {
            output.section(`Canonical example: ${selection.selected.path}`);
            output.kv(
              'Score',
              `${selection.selected.score} (confidence ${selection.selected.confidence})`,
            );
            output.kv('Why', selection.selected.reasons.join('; '));
            output.kv('Next action', selection.nextAction);
            for (const candidate of selection.candidates)
              output.kv(
                `  ${candidate.selected ? '*' : '-'} ${candidate.path}`,
                String(candidate.score),
              );
            for (const limitation of limitations) output.warn(`Limitation: ${limitation}`);
          } else output.warn(selection.nextAction);
        });
      }),
    );
}
