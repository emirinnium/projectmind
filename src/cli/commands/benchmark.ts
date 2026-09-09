import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { parseBenchmarkCorpusManifest, parseBenchmarkManifest } from '@/core/benchmark/manifest.js';
import {
  parseBenchmarkRunResult,
  renderBenchmarkMarkdown,
  runLexicalSearch,
  runBenchmark,
} from '@/core/benchmark/runner.js';
import {
  aggregateRankingScores,
  RankingObservationSchema,
  scoreRankingObservation,
} from '@/core/benchmark/scoring.js';
import { asyncHandler, loadConfig, output } from '@/cli/utils/shared.js';
import { confineToProject } from '@/mcp/tools/_shared.js';
import { runMcpBenchmark } from './benchmark-mcp.js';
import {
  collectReviewFindings,
  getChangedFiles,
  getChangedLineRanges,
} from './pr-preview-engine.js';
import { planReviewBundles } from '@/core/review/bundle.js';
import { loadReviewPolicy } from '@/core/review/policy.js';
import {
  reflectFindings,
  validateFindingPositions,
  verifiedFindings,
} from '@/core/review/finding-validation.js';
import { writeFileAtomically } from '@/utils/atomic-write.js';

function readManifest(filePath: string, root: string) {
  const absolutePath = confineToProject(filePath, root);
  return parseBenchmarkManifest(JSON.parse(readFileSync(absolutePath, 'utf8')));
}

/** Offline, deterministic benchmark surface. Network corpus preparation is intentionally separate. */
export function createBenchmarkCommand(): Command {
  const command = new Command('benchmark').description(
    'Run deterministic JS/TS quality benchmarks',
  );
  const corpus = new Command('corpus').description(
    'Validate metadata-first public/fixture benchmark corpus manifests',
  );
  corpus
    .command('validate')
    .requiredOption('-m, --manifest <file>', 'Corpus manifest JSON')
    .action(
      asyncHandler(async (opts: { manifest: string }) => {
        const root = loadConfig().projectRoot;
        const manifest = parseBenchmarkCorpusManifest(
          JSON.parse(readFileSync(confineToProject(opts.manifest, root), 'utf8')),
        );
        output.json({
          success: true,
          name: manifest.name,
          access: manifest.access,
          repositories: manifest.repositories.length,
          cases: manifest.cases.length,
          unknownCases: manifest.cases.filter((item) => item.case.unknown).length,
          nextAction:
            'Verify every repository license, commit SHA and expected label independently before publishing a score.',
        });
      }),
    );
  command.addCommand(corpus);
  command
    .command('search')
    .description('Measure the deterministic JS/TS lexical search baseline for one query')
    .requiredOption('-q, --query <query>', 'Search query')
    .option('-k, --limit <n>', 'Maximum results', '10')
    .option('--format <format>', 'Output format: json|markdown', 'json')
    .action(
      asyncHandler(async (opts: { query: string; limit: string; format: string }) => {
        if (!['json', 'markdown'].includes(opts.format))
          throw new Error('--format must be json or markdown.');
        const limit = Number.parseInt(opts.limit, 10);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
          throw new Error('--limit must be an integer between 1 and 50.');
        const result = runLexicalSearch(opts.query, loadConfig().projectRoot, limit);
        if (opts.format === 'json') output.json(result);
        else
          output.raw(
            [
              '# ProjectMind Search Benchmark',
              '',
              `- Query: ${result.query}`,
              `- Files indexed: ${result.filesIndexed}`,
              `- Duration: ${result.durationMs} ms`,
              '',
              '| Rank | Path | Score | Bytes | Estimated tokens |',
              '| ---: | --- | ---: | ---: | ---: |',
              ...result.results.map(
                (item, index) =>
                  `| ${index + 1} | ${item.path} | ${item.score} | ${item.sourceBytes} | ${item.estimatedTokens} |`,
              ),
              '',
              ...result.limitations.map((limitation) => `- Limitation: ${limitation}`),
            ].join('\n'),
          );
      }),
    );
  command
    .command('review')
    .description('Benchmark deterministic review coverage and verified findings for a Git diff')
    .option('-b, --base <ref>', 'Base Git revision', 'main')
    .option('-h, --head <ref>', 'Head Git revision', 'HEAD')
    .option('--policy <file>', 'Review policy JSON')
    .option('--format <format>', 'Output format: json|markdown', 'json')
    .action(
      asyncHandler(
        async (opts: { base: string; head: string; policy?: string; format: string }) => {
          if (!['json', 'markdown'].includes(opts.format))
            throw new Error('--format must be json or markdown.');
          const root = loadConfig().projectRoot;
          const policy = loadReviewPolicy(root, opts.policy);
          const changedFiles = await getChangedFiles(opts.base, opts.head, root);
          const allowedLineRanges = await getChangedLineRanges(
            opts.base,
            opts.head,
            root,
            changedFiles,
          );
          const bundles = planReviewBundles(changedFiles, root, policy, { allowedLineRanges });
          const generated = collectReviewFindings(changedFiles, root, policy);
          const validated = validateFindingPositions(generated, bundles, root);
          const reflected = reflectFindings(validated, policy, root);
          const result = {
            success: true,
            base: opts.base,
            head: opts.head,
            changedFiles,
            bundles,
            findings: verifiedFindings(reflected),
            audit: reflected,
            coverage: {
              changedFiles: changedFiles.length,
              bundledFiles: bundles.bundles.flatMap((bundle) => bundle.files).length,
              excludedFiles: bundles.excluded.length,
              generatedFindings: generated.length,
              verifiedFindings: verifiedFindings(reflected).length,
              complete: bundles.excluded.length === 0,
            },
            limitations: [
              'This benchmark measures deterministic policy/bundle/position behavior; it does not judge model-written review quality.',
              'Only verified findings are included in the publishable findings array.',
            ],
          };
          if (opts.format === 'json') output.json(result);
          else
            output.raw(
              [
                '# ProjectMind Review Benchmark',
                '',
                `- Diff: ${opts.base}...${opts.head}`,
                `- Changed files: ${result.coverage.changedFiles}`,
                `- Bundled files: ${result.coverage.bundledFiles}`,
                `- Excluded files: ${result.coverage.excludedFiles}`,
                `- Verified findings: ${result.coverage.verifiedFindings}`,
                `- Complete coverage: ${result.coverage.complete ? 'yes' : 'no'}`,
                '',
                ...result.limitations.map((limitation) => `- Limitation: ${limitation}`),
              ].join('\n'),
            );
        },
      ),
    );
  command
    .command('run')
    .description('Run a manifest against the current project source tree')
    .requiredOption('-m, --manifest <file>', 'Benchmark manifest JSON')
    .option('--format <format>', 'Output format: json|markdown', 'json')
    .option('-o, --output <file>', 'Write the report inside the project root')
    .action(
      asyncHandler(async (opts: { manifest: string; format: string; output?: string }) => {
        if (!['json', 'markdown'].includes(opts.format))
          throw new Error('--format must be json or markdown.');
        const root = loadConfig().projectRoot;
        const result = runBenchmark(readManifest(opts.manifest, root), root);
        const content =
          opts.format === 'markdown'
            ? renderBenchmarkMarkdown(result)
            : JSON.stringify(result, null, 2);
        if (opts.output) {
          writeFileAtomically(confineToProject(opts.output, root), content);
          output.success(`Benchmark report written to ${opts.output}`);
        } else output.raw(content);
      }),
    );
  command
    .command('score')
    .description('Score recorded expected/actual rankings without running a scanner')
    .requiredOption('-i, --input <file>', 'JSON array of ranking observations')
    .action(
      asyncHandler(async (opts: { input: string }) => {
        const root = loadConfig().projectRoot;
        const raw: unknown = JSON.parse(readFileSync(confineToProject(opts.input, root), 'utf8'));
        if (!Array.isArray(raw)) throw new Error('Benchmark score input must be a JSON array.');
        const observations = raw.map((item, index) => {
          const parsed = RankingObservationSchema.safeParse(item);
          if (!parsed.success) throw new Error(`Invalid benchmark observation at index ${index}.`);
          return parsed.data;
        });
        const scores = observations.map(scoreRankingObservation);
        output.json({ scores, aggregate: aggregateRankingScores(scores) });
      }),
    );
  command
    .command('report')
    .description('Render a previously recorded benchmark JSON result as Markdown')
    .requiredOption('-i, --input <file>', 'Benchmark result JSON')
    .option('-o, --output <file>', 'Write Markdown inside the project root')
    .action(
      asyncHandler(async (opts: { input: string; output?: string }) => {
        const root = loadConfig().projectRoot;
        const raw: unknown = JSON.parse(readFileSync(confineToProject(opts.input, root), 'utf8'));
        const result = parseBenchmarkRunResult(raw);
        const markdown = renderBenchmarkMarkdown(result);
        if (opts.output) {
          writeFileAtomically(confineToProject(opts.output, root), markdown);
          output.success(`Benchmark Markdown report written to ${opts.output}`);
        } else output.raw(markdown);
      }),
    );
  command
    .command('prepare')
    .description('Create a minimal fixture manifest template for manual golden labeling')
    .option('-o, --output <file>', 'Template destination', '.projectmind/benchmark-manifest.json')
    .action(
      asyncHandler(async (opts: { output: string }) => {
        const root = loadConfig().projectRoot;
        const template = {
          version: 1,
          name: 'projectmind-local-golden',
          license: 'Repository-specific; verify before publishing',
          access: 'fixture',
          seed: 0,
          cases: [
            {
              id: 'example-search',
              query: 'authentication token',
              expectedPaths: ['src/auth/index.ts'],
              aliases: [],
              unknown: false,
              kind: 'search',
            },
          ],
        };
        writeFileAtomically(confineToProject(opts.output, root), JSON.stringify(template, null, 2));
        output.success(`Benchmark manifest template written to ${opts.output}`);
      }),
    );
  command
    .command('mcp')
    .description('Measure safe MCP registration and bounded cold/warm tool invocations')
    .option('--format <format>', 'Output format: json|markdown', 'json')
    .action(
      asyncHandler(async (opts: { format: string }) => {
        if (!['json', 'markdown'].includes(opts.format))
          throw new Error('--format must be json or markdown.');
        const root = loadConfig().projectRoot;
        const { withService } = await import('@/cli/utils/services.js');
        await withService(['scale', 'debt', 'coherence'], async (ctx, services) => {
          const result = await runMcpBenchmark({
            projectRoot: root,
            kg: ctx.kg,
            db: ctx.db,
            scale: services.scale!,
            debt: services.debt!,
            coherence: services.coherence!,
          });
          if (opts.format === 'markdown') {
            const measured = result.observations.filter((item) => item.measured);
            output.raw(
              [
                '# ProjectMind MCP Benchmark',
                '',
                `- Profile: ${result.profile}`,
                `- Registered tools: ${result.registeredTools}`,
                `- Schema complete: ${result.schemaComplete}`,
                `- Annotation complete: ${result.annotationComplete}`,
                `- Measured safe tools: ${result.measuredTools}`,
                `- Duration: ${result.durationMs} ms`,
                '',
                '| Tool | Cold ms | Warm ms | Cold bytes | Warm bytes |',
                '| --- | ---: | ---: | ---: | ---: |',
                ...measured.map(
                  (item) =>
                    `| ${item.tool} | ${item.coldMs ?? 0} | ${item.warmMs ?? 0} | ${item.coldOutputBytes ?? 0} | ${item.warmOutputBytes ?? 0} |`,
                ),
                '',
                ...result.limitations.map((limitation) => `- Limitation: ${limitation}`),
                `- Next action: ${result.nextAction}`,
              ].join('\n'),
            );
          } else output.json(result);
        });
      }),
    );
  return command;
}
