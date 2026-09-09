import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import {
  initEmbeddingProvider,
  initializeConfiguredEmbeddingProvider,
  getCurrentProvider,
  generateEmbedding,
} from '@/parser/embeddings.js';
import { cosineSimilarity } from '@/parser/embeddings.js';

export function createEmbedCommand(): Command {
  const embedCmd = new Command('embed').description(
    'Embedding generation and code similarity search',
  );

  embedCmd.action(() => {
    embedCmd.outputHelp();
  });

  embedCmd
    .command('init')
    .description('Initialize the embedding provider')
    .option(
      '-p, --provider <provider>',
      'Embedding provider: simple|openai|transformers|unixcoder|codebert',
      'simple',
    )
    .option('-m, --model-path <path>', 'Path to ONNX model file')
    .option('-d, --dimension <n>', 'Embedding dimension', '768')
    .option('--openai-api-key <key>', 'OpenAI API key (or set OPENAI_API_KEY env var)')
    .option('--openai-model <model>', 'OpenAI model name', 'text-embedding-3-small')
    .option('--transformers-model <model>', 'Transformers.js model name', 'Xenova/all-MiniLM-L6-v2')
    .action(
      asyncHandler(
        async (opts: {
          provider: string;
          modelPath?: string;
          dimension: string;
          openaiApiKey?: string;
          openaiModel?: string;
          transformersModel?: string;
        }) => {
          const dimension = Number.parseInt(opts.dimension, 10);
          if (!Number.isSafeInteger(dimension) || dimension <= 0 || dimension > 4096) {
            throw new Error(`--dimension must be an integer between 1 and 4096: ${opts.dimension}`);
          }
          validateProvider(opts.provider);
          await withService(['scale'], async (_ctx) => {
            await initEmbeddingProvider({
              provider: opts.provider as
                'simple' | 'openai' | 'transformers' | 'unixcoder' | 'codebert',
              modelPath: opts.modelPath,
              dimension,
              openaiApiKey: opts.openaiApiKey,
              openaiModel: opts.openaiModel,
              transformersModel: opts.transformersModel,
            });

            output.success(`Embedding provider initialized: ${getCurrentProvider()}`);
          });
        },
      ),
    );

  embedCmd
    .command('generate')
    .description('Generate embedding for a text or code snippet')
    .requiredOption('-t, --text <text>', 'Text or code to embed')
    .option('-d, --dimension <n>', 'Embedding dimension', '768')
    .option('-p, --provider <provider>', 'Embedding provider override')
    .action(
      asyncHandler(async (opts: { text: string; dimension: string; provider?: string }) => {
        await withService(['scale'], async () => {
          const dimension = Number.parseInt(opts.dimension, 10);
          if (!Number.isSafeInteger(dimension) || dimension <= 0 || dimension > 4096) {
            throw new Error(`--dimension must be an integer between 1 and 4096: ${opts.dimension}`);
          }
          if (opts.provider) validateProvider(opts.provider);
          // Initialize an explicit override, otherwise honor the configured
          // provider so a fresh CLI process queries the same semantic space as
          // the persisted index.
          if (opts.provider) {
            const { loadConfig } = await import('@/utils/config.js');
            const config = loadConfig();
            await initEmbeddingProvider({
              provider: opts.provider as
                'simple' | 'openai' | 'transformers' | 'unixcoder' | 'codebert',
              dimension,
              modelPath:
                opts.provider === 'unixcoder'
                  ? config.embeddings.unixcoderModelPath
                  : opts.provider === 'codebert'
                    ? config.embeddings.codebertModelPath
                    : undefined,
              openaiApiKey: config.embeddings.openaiApiKey,
              openaiModel: config.embeddings.openaiModel,
              transformersModel: config.embeddings.transformersModel,
            });
          } else {
            await initializeConfiguredEmbeddingProvider();
          }

          const embedding = await generateEmbedding(opts.text, dimension);

          output.section(`Embedding (${embedding.length} dims, provider=${getCurrentProvider()})`);
          output.kv('Preview', JSON.stringify(embedding.slice(0, 10)) + '...');
          output.info('Full embedding vector generated successfully.');
        });
      }),
    );

  embedCmd
    .command('similar')
    .description('Find similar code snippets in the codebase')
    .requiredOption('-t, --text <text>', 'Query text or code')
    .option('-d, --dimension <n>', 'Embedding dimension', '768')
    .option('-k, --top-k <n>', 'Number of results', '10')
    .action(
      asyncHandler(async (opts: { text: string; dimension: string; topK: string }) => {
        const dimension = Number.parseInt(opts.dimension, 10);
        const topK = Number.parseInt(opts.topK, 10);
        if (!Number.isSafeInteger(dimension) || dimension <= 0 || dimension > 4096) {
          throw new Error(`--dimension must be an integer between 1 and 4096: ${opts.dimension}`);
        }
        if (!Number.isSafeInteger(topK) || topK <= 0 || topK > 1000) {
          throw new Error(`--top-k must be an integer between 1 and 1000: ${opts.topK}`);
        }
        await withService(['scale'], async (ctx) => {
          await initializeConfiguredEmbeddingProvider();
          const kg = ctx.kg;
          const queryEmbedding = await generateEmbedding(opts.text, dimension);
          const results = kg
            .findSimilarFiles(queryEmbedding, 0.01, topK)
            .map((file) => {
              const embedding = kg.getFileEmbedding(file.id);
              return {
                file,
                score: embedding ? cosineSimilarity(queryEmbedding, embedding) : 0,
              };
            })
            .sort((a, b) => b.score - a.score);

          output.section(`Similarity Search (${results.length} results)`);

          if (results.length === 0) {
            output.warn('No similar code found.');
            return;
          }

          for (const { file, score } of results) {
            output.kv(`${file.relativePath}:${file.language || '?'}`, `score=${score.toFixed(4)}`);
          }
        });
      }),
    );

  embedCmd
    .command('provider')
    .description('Show the current embedding provider')
    .action(
      asyncHandler(async () => {
        await withService(['scale'], async () => {
          output.kv('Provider', getCurrentProvider());
        });
      }),
    );

  return embedCmd;
}

function validateProvider(provider: string): void {
  const supported = ['simple', 'openai', 'transformers', 'unixcoder', 'codebert'];
  if (!supported.includes(provider)) {
    throw new Error(`--provider must be one of ${supported.join(', ')}: ${provider}`);
  }
}
