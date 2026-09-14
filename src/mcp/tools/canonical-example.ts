import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { McpDependencies } from './types.js';
import { assertProjectPath } from '@/core/security/path-security.js';
import { HistoryRanker } from '@/core/search/history-ranking.js';
import { lexicalRelevance } from '@/core/search/hybrid-ranking.js';
import { selectCanonicalExample, sourceHash } from '@/core/search/canonical-example.js';
import { actionableMcpError } from '@/utils/actionable-error.js';
import { logger } from '@/utils/logger.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const FILE_READ_CONCURRENCY = 16;

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker()),
  );
  return results;
}

export function registerCanonicalExampleTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'get_canonical_example',
    {
      title: 'Get Canonical Example',
      description:
        'Select a source-backed JS/TS example using query relevance, graph, Git history, ownership, test, coherence and freshness signals. Missing signals remain neutral and the result includes evidence and confidence.',
      inputSchema: {
        query: z.string().trim().min(1).max(1000),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async (args) => {
      try {
        const history = new HistoryRanker(deps.projectRoot);
        const skippedFiles: string[] = [];
        const files = deps.kg
          .getAllFiles()
          .filter((file) => SOURCE_EXTENSIONS.has(extname(file.relativePath).toLowerCase()))
          .slice(0, 500);
        const historyScores = history.scoreMany(files.map((file) => file.relativePath));
        const candidateResults = await mapWithConcurrency(
          files,
          FILE_READ_CONCURRENCY,
          async (file) => {
            try {
              const absolutePath = assertProjectPath(file.relativePath, deps.projectRoot, {
                mustExist: true,
                rejectIgnored: true,
              });
              const content = await readFile(absolutePath, 'utf8');
              const connections =
                (deps.kg.getImports(file.id)?.length ?? 0) +
                (deps.kg.getDependents(file.id)?.length ?? 0);
              const ageDays = Math.max(
                0,
                (Date.now() - Date.parse(file.lastScanned || '')) / 86_400_000,
              );
              const freshness = Number.isFinite(ageDays) ? Math.exp(-ageDays / 30) : 0.5;
              return {
                candidate: {
                  path: file.relativePath,
                  sourceHash: sourceHash(content),
                  relevanceScore: lexicalRelevance(args.query, file.relativePath, content),
                  historyScore: historyScores.get(file.relativePath.replace(/\\/g, '/')),
                  graphScore: Math.min(1, 0.2 + connections * 0.05),
                  ownershipScore: file.agentTouched ? 0.65 : 0.5,
                  testScore: /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(file.relativePath) ? 0.9 : 0.5,
                  coherenceScore: Math.max(0.2, 1 - Math.min(1, file.cognitiveLoad / 10)),
                  freshnessScore: freshness,
                },
              };
            } catch (error) {
              skippedFiles.push(file.relativePath);
              logger.debug('Canonical example skipped an unreadable source file.', {
                filePath: file.relativePath,
                error: error instanceof Error ? error.message : String(error),
              });
              return { candidate: null };
            }
          },
        );
        const candidates = candidateResults.flatMap((result) =>
          result.candidate ? [result.candidate] : [],
        );
        const selection = selectCanonicalExample(candidates);
        const result = selection.candidates.slice(0, args.limit);
        const limitations =
          skippedFiles.length > 0
            ? [
                `${skippedFiles.length} indexed source file(s) were skipped because they could not be read or did not pass path policy.`,
              ]
            : [];
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ...selection,
                  candidates: result,
                  skippedFiles: skippedFiles.slice(0, 50),
                  limitations,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );
}
